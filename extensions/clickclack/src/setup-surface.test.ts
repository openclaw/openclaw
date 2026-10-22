import fs from "node:fs";
import path from "node:path";
import {
  createPluginSetupWizardConfigure,
  createQueuedWizardPrompter,
  createNonExitingRuntimeEnv,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  createClient: vi.fn(),
  me: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

vi.mock("./http-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-client.js")>()),
  createClickClackClient: (options: unknown) => {
    mocks.createClient(options);
    return { me: mocks.me, workspaces: mocks.workspaces };
  },
}));

import { clickClackSetupPlugin } from "./channel.setup.js";
import { ClickClackHttpError } from "./http-client.js";
import { clickClackSetupWizard } from "./setup-surface.js";
import { verifyClickClackAccountAfterSetup } from "./setup-verify.js";
import type { CoreConfig } from "./types.js";

const { credentials, status, introNote, finalize } = clickClackSetupWizard;
const [credential] = credentials;
if (!credential) {
  throw new Error("expected ClickClack token credential");
}
const account = {
  baseUrl: "https://clickclack.example",
  token: "ccb_test",
  workspace: "default",
};
function channelConfig(
  overrides: NonNullable<NonNullable<CoreConfig["channels"]>["clickclack"]> = {},
) {
  return { channels: { clickclack: { ...account, ...overrides } } };
}
const configuredAccount = channelConfig();
const tokenRef = { source: "file", provider: "vault", id: "/clickclack/token" };
const runningMessage = "OpenClaw is running — ClickClack will connect automatically.";
const connectedMessage = "Connected as @openclaw — workspace Default resolved.";
const warnings = [
  [
    () => mocks.me.mockRejectedValue(new ClickClackHttpError(401, "unauthorized", new Headers())),
    "ClickClack rejected the bot token (401). Copy a current token and rerun setup.",
  ],
  [
    () => mocks.workspaces.mockResolvedValue([]),
    'Workspace "default" was not found. Check the id, slug, or name, list available workspaces, and rerun setup.',
  ],
  [
    () => mocks.me.mockRejectedValue(new Error("network unavailable")),
    "Connection check failed: network unavailable. Setup was saved; fix the connection and rerun setup.",
  ],
] as const;

async function verify(overrides: Parameters<typeof channelConfig>[0] = {}) {
  const runtime = createNonExitingRuntimeEnv();
  await verifyClickClackAccountAfterSetup({
    cfg: channelConfig(overrides),
    accountId: "default",
    runtime,
  });
  return runtime;
}

function expectLogs(runtime: Awaited<ReturnType<typeof verify>>, message: string) {
  expect(vi.mocked(runtime.log).mock.calls).toEqual([[message], [runningMessage]]);
}

function expectCredential(
  cfg: CoreConfig,
  hasConfiguredValue: boolean,
  resolvedValue: string | undefined,
  extra: Record<string, unknown> = {},
) {
  expect(credential.inspect({ cfg, accountId: "default" })).toMatchObject({
    accountConfigured: true,
    hasConfiguredValue,
    resolvedValue,
    ...extra,
  });
}

async function expectValidationNote(message: string, cfg = configuredAccount) {
  const note = vi.fn(async () => undefined);
  await expect(
    runSetupWizardFinalize({
      finalize,
      cfg,
      prompter: createTestWizardPrompter({ note }),
    }),
  ).resolves.toBeUndefined();
  expect(note).toHaveBeenCalledWith(message, "ClickClack connection check");
}

describe("ClickClack setup wizard", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    mocks.callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
    mocks.me.mockReset().mockResolvedValue({ id: "usr_bot", handle: "openclaw" });
    mocks.workspaces.mockReset();
    mocks.workspaces.mockResolvedValue([
      { id: "wsp_default", name: "Default", slug: "default", created_at: "2026-01-01" },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects configured accounts and inspects plain, env, and file credentials", async () => {
    expect(await status.resolveConfigured({ cfg: configuredAccount })).toBe(true);
    expectCredential(configuredAccount, true, "ccb_test");

    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "ccb_env");
    expectCredential(channelConfig({ token: undefined }), false, "ccb_env", {
      envValue: "ccb_env",
    });

    await withTempDir("clickclack-setup-token-", async (tempDir) => {
      const tokenFile = path.join(tempDir, "token");
      fs.writeFileSync(tokenFile, "ccb_file\n", "utf8");
      expectCredential(channelConfig({ token: undefined, tokenFile }), true, "ccb_file");
    });

    const secretRefAccount = channelConfig({ token: tokenRef });
    expect(await status.resolveConfigured({ cfg: secretRefAccount })).toBe(true);
    expectCredential(secretRefAccount, true, undefined);
    expect(
      introNote?.shouldShow?.({
        cfg: secretRefAccount,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe(false);
  });

  it("switches the default account to env auth before URL and workspace prompts", async () => {
    const next = await credential.applyUseEnv?.({
      cfg: channelConfig({ token: "ccb_stale", tokenFile: "/run/secrets/stale" }),
      accountId: "default",
    });

    expect(next?.channels?.clickclack).not.toHaveProperty("token");
    expect(next?.channels?.clickclack).not.toHaveProperty("tokenFile");
    expect(next?.channels?.clickclack).toMatchObject({
      baseUrl: "https://clickclack.example",
      workspace: "default",
    });
  });

  it("saves URL, token, and workspace through the guided flow", async () => {
    const queued = createQueuedWizardPrompter({
      textValues: ["ccb_guided", "https://clickclack.example/", "default"],
    });

    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(clickClackSetupPlugin),
      cfg: {} as CoreConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.cfg.channels?.clickclack).toMatchObject({
      enabled: true,
      token: "ccb_guided",
      baseUrl: "https://clickclack.example",
      workspace: "default",
    });
    expect(mocks.me).toHaveBeenCalledTimes(1);
    expect(queued.prompter.note).toHaveBeenCalledWith(connectedMessage, "ClickClack connection");
  });

  it("uses the resolved setup credential for live validation", async () => {
    await runSetupWizardFinalize({
      finalize,
      cfg: channelConfig({ token: tokenRef }),
      credentialValues: { token: "ccb_resolved" },
    });

    expect(mocks.createClient).toHaveBeenCalledWith({
      baseUrl: "https://clickclack.example",
      token: "ccb_resolved",
    });
  });

  it.each(warnings)("keeps setup saved on validation failure (%#)", async (arrange, message) => {
    arrange();
    await expectValidationNote(message);
  });

  it.each(warnings)("logs a warning and continues after writing (%#)", async (arrange, message) => {
    arrange();
    expectLogs(await verify(), message);
  });

  it.each(["default", "wsp_default", "Default"])(
    "verifies workspace selector %s",
    async (workspace) => {
      const runtime = await verify({ workspace, apiBaseUrl: "http://127.0.0.1:8484" });
      expect(mocks.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "http://127.0.0.1:8484" }),
      );
      expectLogs(runtime, connectedMessage);
    },
  );

  it("skips verification when the implicit env token is unavailable", async () => {
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "");
    const runtime = await verify({ token: undefined });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expectLogs(runtime, "Token comes from CLICKCLACK_BOT_TOKEN; verification skipped.");
  });

  it.each([
    [
      Object.assign(new Error("gateway closed (1006): no listener"), {
        name: "GatewayTransportError",
        kind: "closed",
        code: 1006,
        connectionDetails: { url: "ws://127.0.0.1:18789", message: "Local Gateway" },
      }),
      "Start OpenClaw to connect: openclaw gateway",
    ],
    [
      new Error("probe failed"),
      "If OpenClaw is running it connects automatically; otherwise start it with: openclaw gateway",
    ],
  ])("prints the gateway next step (%#)", async (error, expected) => {
    mocks.callGatewayFromCli.mockRejectedValue(error);
    const runtime = await verify();
    expect(runtime.log).toHaveBeenNthCalledWith(2, expected);
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
      "health",
      { timeout: "1000", json: true },
      undefined,
      { expectFinal: false, progress: false },
    );
  });
});
