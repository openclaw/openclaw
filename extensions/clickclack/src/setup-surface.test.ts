import fs from "node:fs";
import path from "node:path";
import {
  createPluginSetupWizardConfigure,
  createQueuedWizardPrompter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  me: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    mocks.createClient(options);
    return {
      me: mocks.me,
      workspaces: mocks.workspaces,
    };
  },
}));

import { clickClackSetupPlugin } from "./channel.setup.js";
import { clickClackSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const { credentials, status, introNote, finalize } = clickClackSetupWizard;
function requireCredential() {
  const credential = credentials[0];
  if (!credential) {
    throw new Error("expected ClickClack token credential");
  }
  return credential;
}
const credential = requireCredential();
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
    expect(queued.prompter.note).toHaveBeenCalledWith(
      "Connected as @openclaw — workspace Default resolved.",
      "ClickClack connection",
    );
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

  it("keeps setup saved when the token is rejected", async () => {
    mocks.me.mockRejectedValue({ status: 401 });
    await expectValidationNote(
      "ClickClack rejected the bot token (401). Copy a current token and rerun setup.",
    );
  });

  it("keeps setup saved when workspace resolution fails", async () => {
    mocks.workspaces.mockResolvedValue([]);
    await expectValidationNote(
      'Workspace "wsp_missing" was not found. Check the id, slug, or name, list available workspaces, and rerun setup.',
      channelConfig({ workspace: "wsp_missing" }),
    );
  });

  it("keeps setup saved when the server is unreachable", async () => {
    mocks.me.mockRejectedValue(new Error("network unavailable"));
    await expectValidationNote(
      "Connection check failed: network unavailable. Setup was saved; fix the connection and rerun setup.",
    );
  });
});
