import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginSetupWizardConfigure,
  createQueuedWizardPrompter,
  createNonExitingRuntimeEnv,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackAccount } from "./accounts.js";
import { applyClickClackCredentialConfig, clickClackSetupContract } from "./setup-core.js";

const claimClickClackSetupCode = vi.hoisted(() => vi.fn());
vi.mock("./setup-claim.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-claim.js")>()),
  claimClickClackSetupCode,
}));

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
import type { CoreConfig } from "./types.js";

const { credentials, status, introNote, finalize } = clickClackSetupWizard;
const [tokenCredential] = credentials;
if (!tokenCredential) {
  throw new Error("expected ClickClack token credential");
}
const credential = tokenCredential;
const baseInput = { baseUrl: "https://clickclack.example", workspace: "default" };
const account = { ...baseInput, token: "ccb_test" };
function channelConfig(
  overrides: NonNullable<NonNullable<CoreConfig["channels"]>["clickclack"]> = {},
) {
  return { channels: { clickclack: { ...account, ...overrides } } };
}
const configuredAccount = channelConfig();
const tokenRef = { source: "file", provider: "vault", id: "/clickclack/token" };
const claimedAccount = { token: "test-token", workspace: { id: "wsp_1" }, defaults: {} };
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
  await clickClackSetupContract.afterAccountConfigWritten?.({
    previousCfg: {},
    cfg: channelConfig(overrides),
    accountId: "default",
    input: {},
    runtime,
  });
  return runtime;
}

function expectLogs(runtime: Awaited<ReturnType<typeof verify>>, message: string) {
  expect(vi.mocked(runtime.log).mock.calls).toEqual([[message], [runningMessage]]);
}

beforeEach(() => {
  claimClickClackSetupCode.mockReset();
  mocks.createClient.mockReset();
  mocks.callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
  mocks.me.mockReset().mockResolvedValue({ id: "usr_bot", handle: "openclaw" });
  mocks.workspaces
    .mockReset()
    .mockResolvedValue([{ id: "wsp_default", name: "Default", slug: "default" }]);
});

afterEach(() => vi.unstubAllEnvs());

describe("ClickClack setup wizard", () => {
  it("detects configured accounts and inspects env and unresolved credentials", async () => {
    expect(await status.resolveConfigured({ cfg: configuredAccount })).toBe(true);
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "ccb_env");
    expect(
      credential.inspect({ cfg: channelConfig({ token: undefined }), accountId: "default" }),
    ).toMatchObject({
      accountConfigured: true,
      hasConfiguredValue: false,
      resolvedValue: "ccb_env",
      envValue: "ccb_env",
    });
    const secretRefAccount = channelConfig({ token: tokenRef });
    expect(await status.resolveConfigured({ cfg: secretRefAccount })).toBe(true);
    expect(credential.inspect({ cfg: secretRefAccount, accountId: "default" })).toMatchObject({
      accountConfigured: true,
      hasConfiguredValue: true,
      resolvedValue: undefined,
    });
    expect(
      introNote?.shouldShow?.({
        cfg: secretRefAccount,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe(false);
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
      ...baseInput,
      enabled: true,
      token: "ccb_guided",
    });
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

  it.each(warnings)("continues with a warning (%#)", async (arrange, message) => {
    arrange();
    const note = vi.fn(async () => undefined);
    await runSetupWizardFinalize({
      finalize,
      cfg: configuredAccount,
      prompter: createTestWizardPrompter({ note }),
    });
    expect(note).toHaveBeenCalledWith(message, "ClickClack connection check");
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
  });
});

type ClickClackSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  code?: string;
  workspace?: string;
  agentActivity?: boolean;
};

function bareConfig(
  clickclack: NonNullable<NonNullable<CoreConfig["channels"]>["clickclack"]>,
): CoreConfig {
  return { channels: { clickclack } };
}

const defaults = { defaultTo: "channel:general", allowFrom: ["*"], agentActivity: true };
const codeInput = { code: "ABCD-EFGH-JKMN", baseUrl: baseInput.baseUrl };
const publicApiBase = "https://api.clickclack.example/services/clickclack";
const exactClaimUrl = `${publicApiBase}/api/bot-setup-codes/claim`;

function apply(input: ClickClackSetupInput, cfg: CoreConfig = {}, accountId = DEFAULT_ACCOUNT_ID) {
  return clickClackSetupContract.applyAccountConfig({ cfg, accountId, input });
}

function validate(
  input: ClickClackSetupInput,
  cfg: CoreConfig = {},
  accountId = DEFAULT_ACCOUNT_ID,
) {
  return clickClackSetupContract.validateInput?.({ cfg, accountId, input });
}

async function prepare(input: ClickClackSetupInput, cfg: OpenClawConfig = {}) {
  return await clickClackSetupContract.prepareAccountConfigInput?.({
    cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    input,
    runtime: createNonExitingRuntimeEnv(),
  });
}

describe("ClickClack setup adapter", () => {
  it("claims a full setup URL and prepares the token, workspace, and defaults", async () => {
    claimClickClackSetupCode.mockResolvedValue({ ...claimedAccount, defaults });
    await expect(
      prepare({ code: `${baseInput.baseUrl}/#abcd-efgh-jkmn`, name: "Primary" }),
    ).resolves.toEqual({
      name: "Primary",
      baseUrl: baseInput.baseUrl,
      token: "test-token",
      workspace: "wsp_1",
      ...defaults,
    });
    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: `${baseInput.baseUrl}/api/bot-setup-codes/claim`,
      code: "ABCDEFGHJKMN",
    });
  });

  it.each([
    ["public", "abcd-efgh-jkmn", {}, exactClaimUrl],
    [
      "private",
      "ABCD-EFGH-JKMN",
      bareConfig({ apiBaseUrl: "http://127.0.0.1:8484" }),
      "http://127.0.0.1:8484/api/bot-setup-codes/claim",
    ],
  ] as const)(
    "claims an exact endpoint over %s transport and keeps its public API base",
    async (_transport, code, cfg, claimUrl) => {
      claimClickClackSetupCode.mockResolvedValue({
        ...claimedAccount,
        contract_version: 1,
        api_base_url: publicApiBase,
      });

      await expect(prepare({ code: `${exactClaimUrl}#${code}` }, cfg)).resolves.toHaveProperty(
        "baseUrl",
        publicApiBase,
      );
      expect(claimClickClackSetupCode).toHaveBeenCalledWith({
        claimUrl,
        expectedClaimUrl: exactClaimUrl,
        code: "ABCDEFGHJKMN",
      });
    },
  );

  it("rejects conflicting credentials before claiming a setup code", async () => {
    for (const conflicting of [
      { token: "test-token" },
      { tokenFile: "test-token-file" },
      { useEnv: true },
    ]) {
      await expect(prepare({ ...codeInput, ...conflicting })).rejects.toThrow(
        "ClickClack --code cannot be combined with --token, --token-file, or --use-env.",
      );
    }
    expect(claimClickClackSetupCode).not.toHaveBeenCalled();
  });

  it("rejects mismatched and malformed setup-code inputs before claiming", async () => {
    const invalid: Array<[ClickClackSetupInput, string]> = [
      [{ code: "ftp://clickclack.example/#ABCD-EFGH-JKMN" }, "HTTP(S)"],
      [
        { code: "https://clickclack.example/#ABCD-EFGH-JKMN", baseUrl: "https://other.example" },
        "does not match",
      ],
      [{ ...codeInput, code: "not-a-code" }, "12 valid base32 characters"],
      [{ code: "https://clickclack.example/?next=api#ABCD-EFGH-JKMN" }, "must not include a query"],
      [
        { code: `${exactClaimUrl}#ABCD-EFGH-JKMN`, baseUrl: "https://api.clickclack.example" },
        "does not match",
      ],
    ];
    for (const [input, error] of invalid) {
      await expect(prepare(input)).rejects.toThrow(error);
    }
    expect(claimClickClackSetupCode).not.toHaveBeenCalled();
  });

  it("maps invalid and rate-limited claims to actionable errors", async () => {
    for (const [statusCode, message] of [
      [404, "invalid, expired, or already used"],
      [429, "Too many ClickClack setup code attempts"],
    ] as const) {
      claimClickClackSetupCode.mockRejectedValueOnce(
        Object.assign(new Error("claim failed"), { status: statusCode }),
      );
      await expect(prepare(codeInput)).rejects.toThrow(message);
    }
  });

  it("writes setup-code defaults through the existing account patch", () => {
    const input = {
      ...defaults,
      token: "test-token",
      baseUrl: baseInput.baseUrl,
      workspace: "wsp_1",
      defaultTo: " channel:general ",
    };
    expect(apply(input)).toEqual(bareConfig({ ...input, ...defaults, enabled: true }));
  });

  it("limits --use-env to the default account and requires URL and workspace config", () => {
    expect(validate({ ...baseInput, useEnv: true }, {}, "work")).toBe(
      "CLICKCLACK_BOT_TOKEN can only be used for the default account.",
    );
    expect(validate({ useEnv: true })).toBe(
      "ClickClack requires --token, --base-url, and --workspace (or --use-env).",
    );
    expect(validate({ useEnv: true }, bareConfig(baseInput))).toBeNull();
    expect(
      validate({ useEnv: true }, bareConfig({ ...baseInput, baseUrl: "ssh://clickclack.example" })),
    ).toBe("ClickClack base URL must be a valid http(s) URL.");
  });

  it("rejects malformed base URLs before writing config", () => {
    expect(validate({ ...baseInput, token: "ccb_test", baseUrl: "clickclack.example" })).toBe(
      "ClickClack base URL must be a valid http(s) URL.",
    );
  });

  it("clickClackSetupContract.applyAccountConfig preserves the active collision winner", () => {
    const cfg = bareConfig({
      ...account,
      token: "root-token",
      defaultAccount: "ops",
      accounts: { Ops: { name: "Other spelling" }, ops: { name: "Active" } },
    });
    const input = {
      baseUrl: "https://work.clickclack.example",
      workspace: "work",
      token: "work-token",
    };

    expect(validate(input, cfg, "work")).toBeNull();
    const next = apply(input, cfg, "work");

    expect(resolveClickClackAccount({ cfg: next, accountId: "ops" })).toMatchObject({
      name: "Active",
      token: "root-token",
      configured: true,
    });
    expect(next.channels?.clickclack?.accounts?.Ops).toEqual({ name: "Other spelling" });
    expect(resolveClickClackAccount({ cfg: next, accountId: "work" })).toMatchObject({
      ...input,
      configured: true,
    });
  });

  it("clears stale competing credentials when the auth mode changes", () => {
    for (const [patch, previous, cleared] of [
      [{ token: "ccb_new" }, { tokenFile: "/run/secrets/old-token" }, "tokenFile"],
      [{ tokenFile: "/run/secrets/new-token" }, { token: "ccb_old" }, "token"],
    ] as const) {
      const next = apply({ ...baseInput, ...patch }, bareConfig({ ...baseInput, ...previous }));
      expect(next.channels?.clickclack).toMatchObject(patch);
      expect(next.channels?.clickclack).not.toHaveProperty(cleared);
    }

    const withEnv = apply(
      { useEnv: true },
      bareConfig({
        baseUrl: "https://clickclack.example/",
        workspace: " default ",
        token: "ccb_old",
        tokenFile: "/run/secrets/old-token",
      }),
    ).channels?.clickclack;
    expect(withEnv).toEqual({ ...baseInput, enabled: true });

    const namedWithToken = apply(
      { ...baseInput, token: "ccb_work", workspace: "work" },
      bareConfig({ ...baseInput, tokenFile: "/run/secrets/default-token" }),
      "work",
    );
    expect(namedWithToken.channels?.clickclack).not.toHaveProperty("tokenFile");
    expect(namedWithToken.channels?.clickclack?.accounts).toMatchObject({
      default: { tokenFile: "/run/secrets/default-token" },
      work: { token: "ccb_work" },
    });
    expect(namedWithToken.channels?.clickclack?.accounts?.work).not.toHaveProperty("tokenFile");
  });

  it("preserves credentials when a partial patch does not select an auth mode", () => {
    expect(
      applyClickClackCredentialConfig({
        cfg: bareConfig({ tokenFile: "/run/secrets/clickclack" }),
        accountId: DEFAULT_ACCOUNT_ID,
      }).channels?.clickclack,
    ).toMatchObject({
      enabled: true,
      tokenFile: "/run/secrets/clickclack",
    });
  });
});
