import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

const claimClickClackSetupCode = vi.hoisted(() => vi.fn());
const verifyClickClackAccountAfterSetup = vi.hoisted(() => vi.fn());

vi.mock("./setup-claim.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-claim.js")>()),
  claimClickClackSetupCode,
}));
vi.mock("./setup-verify.js", () => ({
  verifyClickClackAccountAfterSetup,
}));
import { applyClickClackCredentialConfig, clickClackSetupContract } from "./setup-core.js";

type ClickClackSetupCodeClaim = Awaited<
  ReturnType<typeof import("./setup-claim.js").claimClickClackSetupCode>
>;

type ClickClackSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  code?: string;
  workspace?: string;
  agentActivity?: boolean;
};

function makeClaimError(status: number, detail: string): Error {
  return Object.assign(new Error(`claim failed (${status}): ${detail}`), { status });
}

function channelConfig(
  clickclack: NonNullable<NonNullable<CoreConfig["channels"]>["clickclack"]>,
): CoreConfig {
  return { channels: { clickclack } };
}

const baseInput = { baseUrl: "https://clickclack.example", workspace: "default" };
const codeInput = { code: "ABCD-EFGH-JKMN", baseUrl: baseInput.baseUrl };
const exactClaimUrl =
  "https://api.clickclack.example/services/clickclack/api/bot-setup-codes/claim";

function apply(input: ClickClackSetupInput, cfg: CoreConfig = {}, accountId = DEFAULT_ACCOUNT_ID) {
  return clickClackSetupContract.applyAccountConfig({ cfg, accountId, input });
}

function claimResponse(
  overrides: Partial<ClickClackSetupCodeClaim> = {},
): ClickClackSetupCodeClaim {
  return {
    token: "test-token",
    bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
    workspace: { id: "wsp_1", route_id: "clickclack", slug: "default", name: "ClickClack" },
    defaults: {},
    ...overrides,
  };
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
  beforeEach(() => {
    claimClickClackSetupCode.mockReset();
  });

  it("claims a full setup URL and prepares the token, workspace, and defaults", async () => {
    claimClickClackSetupCode.mockResolvedValue(
      claimResponse({
        defaults: {
          defaultTo: "channel:general",
          allowFrom: ["*"],
          agentActivity: true,
        },
      }),
    );

    await expect(
      prepare({
        code: "https://clickclack.example/#abcd-efgh-jkmn",
        name: "Primary",
      }),
    ).resolves.toEqual({
      name: "Primary",
      baseUrl: "https://clickclack.example",
      token: "test-token",
      workspace: "wsp_1",
      defaultTo: "channel:general",
      allowFrom: ["*"],
      agentActivity: true,
    });
    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: "https://clickclack.example/api/bot-setup-codes/claim",
      code: "ABCDEFGHJKMN",
    });
  });

  it.each([
    ["public", "abcd-efgh-jkmn", {}, exactClaimUrl],
    [
      "private",
      "ABCD-EFGH-JKMN",
      channelConfig({ apiBaseUrl: "http://127.0.0.1:8484" }),
      "http://127.0.0.1:8484/api/bot-setup-codes/claim",
    ],
  ] as const)(
    "claims an exact endpoint over %s transport and keeps its public API base",
    async (_transport, code, cfg, claimUrl) => {
      claimClickClackSetupCode.mockResolvedValue(
        claimResponse({
          contract_version: 1,
          api_base_url: "https://api.clickclack.example/services/clickclack",
        }),
      );

      await expect(prepare({ code: `${exactClaimUrl}#${code}` }, cfg)).resolves.toMatchObject({
        baseUrl: "https://api.clickclack.example/services/clickclack",
        token: "test-token",
        workspace: "wsp_1",
      });
      expect(claimClickClackSetupCode).toHaveBeenCalledWith({
        claimUrl,
        expectedClaimUrl: exactClaimUrl,
        code: "ABCDEFGHJKMN",
      });
    },
  );

  it("rejects conflicting credentials before claiming a setup code", async () => {
    for (const credentials of [
      { token: "test-token" },
      { tokenFile: "test-token-file" },
      { useEnv: true },
    ]) {
      await expect(prepare({ ...codeInput, ...credentials })).rejects.toThrow(
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
    claimClickClackSetupCode.mockRejectedValueOnce(makeClaimError(404, "not found"));
    await expect(prepare(codeInput)).rejects.toThrow("invalid, expired, or already used");

    claimClickClackSetupCode.mockRejectedValueOnce(makeClaimError(429, "retry later"));
    await expect(prepare(codeInput)).rejects.toThrow("Too many ClickClack setup code attempts");
  });

  it("writes setup-code defaults through the existing account patch", () => {
    expect(
      apply({
        token: "test-token",
        baseUrl: "https://clickclack.example",
        workspace: "wsp_1",
        defaultTo: " channel:general ",
        allowFrom: ["*"],
        agentActivity: true,
      }),
    ).toEqual({
      channels: {
        clickclack: {
          enabled: true,
          token: "test-token",
          baseUrl: "https://clickclack.example",
          workspace: "wsp_1",
          defaultTo: "channel:general",
          allowFrom: ["*"],
          agentActivity: true,
        },
      },
    });
  });

  it("limits --use-env to the default account and requires URL and workspace config", () => {
    expect(validate({ ...baseInput, useEnv: true }, {}, "work")).toBe(
      "CLICKCLACK_BOT_TOKEN can only be used for the default account.",
    );
    expect(validate({ useEnv: true })).toBe(
      "ClickClack requires --token, --base-url, and --workspace (or --use-env).",
    );
    expect(validate({ useEnv: true }, channelConfig(baseInput))).toBeNull();
    expect(
      validate(
        { useEnv: true },
        channelConfig({ ...baseInput, baseUrl: "ssh://clickclack.example" }),
      ),
    ).toBe("ClickClack base URL must be a valid http(s) URL.");
  });

  it("rejects malformed base URLs before writing config", () => {
    expect(validate({ ...baseInput, token: "ccb_test", baseUrl: "clickclack.example" })).toBe(
      "ClickClack base URL must be a valid http(s) URL.",
    );
  });

  it("clickClackSetupContract.applyAccountConfig preserves the active collision winner", () => {
    const cfg = channelConfig({
      baseUrl: "https://old.clickclack.example",
      workspace: "old",
      token: "root-token",
      defaultAccount: "ops",
      accounts: {
        Ops: { name: "Other spelling" },
        ops: { name: "Active" },
      },
    });
    const input = {
      baseUrl: "https://work.clickclack.example",
      workspace: "work",
      token: "work-token",
    } satisfies ClickClackSetupInput;

    expect(resolveClickClackAccount({ cfg, accountId: "ops" })).toMatchObject({
      name: "Active",
      token: "root-token",
      configured: true,
    });
    expect(validate(input, cfg, "work")).toBeNull();
    const next = apply(input, cfg, "work");

    expect(resolveClickClackAccount({ cfg: next, accountId: "ops" })).toMatchObject({
      name: "Active",
      token: "root-token",
      configured: true,
    });
    expect(next.channels?.clickclack?.accounts?.Ops).toEqual({ name: "Other spelling" });
    expect(resolveClickClackAccount({ cfg: next, accountId: "work" })).toMatchObject({
      baseUrl: "https://work.clickclack.example",
      workspace: "work",
      token: "work-token",
      configured: true,
    });
  });

  it("clears stale competing credentials when the auth mode changes", () => {
    for (const [patch, previous, cleared] of [
      [{ token: "ccb_new" }, { tokenFile: "/run/secrets/old-token" }, "tokenFile"],
      [{ tokenFile: "/run/secrets/new-token" }, { token: "ccb_old" }, "token"],
    ] as const) {
      const next = apply({ ...baseInput, ...patch }, channelConfig({ ...baseInput, ...previous }));
      expect(next.channels?.clickclack).toMatchObject(patch);
      expect(next.channels?.clickclack).not.toHaveProperty(cleared);
    }

    const withEnv = apply(
      { useEnv: true },
      channelConfig({
        baseUrl: "https://clickclack.example/",
        workspace: " default ",
        token: "ccb_old",
        tokenFile: "/run/secrets/old-token",
      }),
    );
    expect(withEnv.channels?.clickclack).not.toHaveProperty("token");
    expect(withEnv.channels?.clickclack).not.toHaveProperty("tokenFile");
    expect(withEnv.channels?.clickclack).toMatchObject({
      baseUrl: "https://clickclack.example",
      workspace: "default",
    });

    const namedWithToken = apply(
      { ...baseInput, token: "ccb_work", workspace: "work" },
      channelConfig({ ...baseInput, tokenFile: "/run/secrets/default-token" }),
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
    const cfg = channelConfig({ tokenFile: "/run/secrets/clickclack" });

    expect(
      applyClickClackCredentialConfig({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      }).channels?.clickclack,
    ).toMatchObject({
      enabled: true,
      tokenFile: "/run/secrets/clickclack",
    });
  });

  it("runs post-write verification with the saved account config", async () => {
    const cfg = channelConfig({ ...baseInput, token: "ccb_test" });
    const runtime = createNonExitingRuntimeEnv();

    await clickClackSetupContract.afterAccountConfigWritten?.({
      previousCfg: {},
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input: {},
      runtime,
    });

    expect(verifyClickClackAccountAfterSetup).toHaveBeenCalledWith({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      runtime,
    });
  });
});
