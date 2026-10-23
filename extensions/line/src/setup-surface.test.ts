import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, ResolvedLineAccount } from "../api.js";
import { linePlugin } from "./channel.js";
import { lineGatewayAdapter } from "./gateway.js";
import { stubLineApiFetch } from "./probe.test-support.js";
import { setLineRuntime } from "./runtime.js";
import { lineSetupWizard } from "./setup-surface.js";
const monitorLineProviderMock = vi.hoisted(() =>
  vi.fn<typeof import("./monitor.js").monitorLineProvider>(),
);
vi.mock("./monitor.js", () => ({ monitorLineProvider: monitorLineProviderMock }));
afterEach(() => {
  monitorLineProviderMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  vi.doUnmock("./monitor.js");
  vi.resetModules();
});
const lineConfigure = createPluginSetupWizardConfigure(linePlugin);
const credentials = (token = "token", secret = "secret") => ({
  channelAccessToken: token,
  channelSecret: secret,
});
const lineConfig = (line: NonNullable<OpenClawConfig["channels"]>["line"]): OpenClawConfig => ({
  channels: { line },
});
const identity = {
  displayName: "OpenClaw",
  userId: "U123",
  basicId: "@openclaw",
  pictureUrl: "https://example.com/bot.png",
};
const stubBot = () => stubLineApiFetch(Response.json(identity), Response.json({ type: "none" }));
describe("line setup wizard", () => {
  it("configures token and secret for the default account", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter LINE channel access token") {
          return "line-token";
        }
        if (message === "Enter LINE channel secret") {
          return "line-secret";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });
    const result = await runSetupWizardConfigure({
      configure: lineConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });
    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.line).toMatchObject({
      enabled: true,
      ...credentials("line-token", "line-secret"),
    });
  });
  it("uses defaultAccount for policy reads and writes without changing root policy", () => {
    const cfg = lineConfig({
      defaultAccount: "work",
      dmPolicy: "disabled",
      allowFrom: ["Uroot"],
      accounts: { work: { ...credentials(), dmPolicy: "allowlist" } },
    });
    const policy = lineSetupWizard.dmPolicy!;
    expect(policy.getCurrent(cfg)).toBe("allowlist");
    expect(policy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.line.accounts.work.dmPolicy",
      allowFromKey: "channels.line.accounts.work.allowFrom",
    });
    const next = policy.setPolicy(cfg, "open");
    expect(next.channels?.line).toMatchObject({
      dmPolicy: "disabled",
      allowFrom: ["Uroot"],
      accounts: { work: { dmPolicy: "open", allowFrom: ["Uroot", "*"] } },
    });
  });
  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await lineSetupWizard.status.resolveConfigured({
      cfg: lineConfig({
        defaultAccount: "work",
        ...credentials("root-token", "root-secret"),
        accounts: {
          alerts: credentials("alerts-token", "alerts-secret"),
          work: credentials("", ""),
        },
      }),
    });
    expect(configured).toBe(false);
  });
});
it("status.probeAccount reports bot identity without initializing the message runtime", async () => {
  vi.resetModules();
  const { lineStatusAdapter } = await import("./status.js");
  const fetchMock = stubBot();
  const params = {
    cfg: {} as OpenClawConfig,
    account: createAccount(),
    timeoutMs: 50,
  };
  await expect(lineStatusAdapter.probeAccount!(params)).resolves.toEqual({
    ok: true,
    bot: identity,
    quota: { kind: "unlimited" },
    elapsedMs: expect.any(Number),
  });
  expect(fetchMock.mock.calls.map(([url]) => resolveRequestUrl(url))).toEqual([
    "https://api.line.me/v2/bot/info",
    "https://api.line.me/v2/bot/message/quota",
    "https://api.line.me/v2/bot/channel/webhook/endpoint",
  ]);
});
function startLineAccount(params: { account: ResolvedLineAccount; abortSignal?: AbortSignal }) {
  const providerStarted = createDeferred<void>();
  monitorLineProviderMock.mockImplementation(async (opts) => {
    providerStarted.resolve();
    await waitForAbortSignal(opts.abortSignal);
    return {
      account: params.account,
      handleWebhook: async () => "ignored" as const,
      stop: async () => {},
    };
  });
  setLineRuntime({ logging: { shouldLogVerbose: () => false } } as unknown as PluginRuntime);
  const statusEvents: unknown[] = [];
  return {
    monitorLineProvider: monitorLineProviderMock,
    providerStarted: providerStarted.promise,
    statusEvents,
    task: lineGatewayAdapter.startAccount!(
      createStartAccountContext({
        account: params.account,
        abortSignal: params.abortSignal,
        statusPatchSink: (patch) => statusEvents.push(patch),
      }),
    ),
  };
}
function createAccount(token = "token", secret = "secret"): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    ...credentials(token, secret),
    tokenSource: "config",
    config: {},
  };
}
describe("linePlugin gateway.startAccount", () => {
  it.each([
    { token: "token", secret: "   ", field: "channel secret" },
    { token: "   ", secret: "secret", field: "channel access token" },
  ])("fails startup when $field is missing", async ({ token, secret, field }) => {
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount(token, secret),
    });
    await expect(task).rejects.toThrow(
      `LINE webhook mode requires a non-empty ${field} for account "default".`,
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });
  it("starts provider when token and secret are present", async () => {
    stubBot();
    const abort = new AbortController();
    const { monitorLineProvider, providerStarted, statusEvents, task } = startLineAccount({
      account: createAccount(),
      abortSignal: abort.signal,
    });
    try {
      await Promise.race([
        providerStarted,
        task.then(() => {
          throw new Error("LINE account exited before the provider started");
        }),
      ]);
      expect(monitorLineProvider).toHaveBeenCalledTimes(1);
      expect(monitorLineProvider.mock.calls[0]?.[0]).toMatchObject({
        ...credentials(),
        accountId: "default",
        statusSink: expect.any(Function),
      });
      expect(monitorLineProvider.mock.calls[0]?.[0].abortSignal).toBe(abort.signal);
      expect(statusEvents).toContainEqual(
        expect.objectContaining({ accountId: "default", lifecycle: "starting" }),
      );
    } finally {
      abort.abort();
      await task;
    }
  });
});
