import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, ResolvedLineAccount } from "../api.js";
import { linePlugin } from "./channel.js";
import { lineGatewayAdapter } from "./gateway.js";
import { stubLineApiFetch } from "./probe.test-support.js";
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
const identity = { userId: "U123", displayName: "OpenClaw" };
const stubBot = () => stubLineApiFetch(Response.json(identity), Response.json({ type: "none" }));
describe("line setup wizard", () => {
  it("configures token and secret for the default account", async () => {
    const prompter = createTestWizardPrompter({
      text: async ({ message }) => {
        const field = /^Enter LINE channel (access token|secret)$/.exec(message)?.[1];
        if (!field) {
          throw new Error(`Unexpected prompt: ${message}`);
        }
        return field === "secret" ? "line-secret" : "line-token";
      },
    });
    const result = await runSetupWizardConfigure({
      configure: lineConfigure,
      cfg: {},
      prompter,
      options: {},
    });
    expect(result).toMatchObject({
      accountId: "default",
      cfg: { channels: { line: { enabled: true, ...credentials("line-token", "line-secret") } } },
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
  stubBot();
  await expect(
    lineStatusAdapter.probeAccount!({ cfg: {}, account: createAccount(), timeoutMs: 50 }),
  ).resolves.toMatchObject({ ok: true, bot: identity, quota: { kind: "unlimited" } });
});
function startLineAccount(account = createAccount(), abortSignal?: AbortSignal) {
  const context = createStartAccountContext({ account, abortSignal });
  return { context, task: lineGatewayAdapter.startAccount!(context) };
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
    const { task } = startLineAccount(createAccount(token, secret));
    await expect(task).rejects.toThrow(
      `LINE webhook mode requires a non-empty ${field} for account "default".`,
    );
    expect(monitorLineProviderMock).not.toHaveBeenCalled();
  });
  it("starts provider when token and secret are present", async () => {
    stubBot();
    const account = createAccount();
    const monitor = {
      account,
      handleWebhook: async () => "ignored" as const,
      stop: async () => {},
    };
    monitorLineProviderMock.mockResolvedValueOnce(monitor);
    const abort = new AbortController();
    const { context, task } = startLineAccount(account, abort.signal);
    await expect(task).resolves.toBe(monitor);
    expect(monitorLineProviderMock.mock.calls[0]?.[0]).toMatchObject({
      ...credentials(),
      accountId: "default",
      statusSink: expect.any(Function),
    });
    expect(monitorLineProviderMock.mock.calls[0]?.[0].abortSignal).toBe(abort.signal);
    expect(context.getStatus()).toMatchObject({ accountId: "default", lifecycle: "starting" });
  });
});
