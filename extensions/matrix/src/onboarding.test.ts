import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixOnboardingAdapter } from "./onboarding.js";
import {
  createConfiguredMatrixDefaultAccountConfig,
  createConfiguredMatrixTopLevelConfig,
  createMatrixEnvShortcutAddAccountPrompter,
  createMatrixNamedAccountsConfig,
  createLegacyMatrixTopLevelConfig,
  installMatrixScopedEnvShortcut,
  createMatrixTokenAddAccountPrompter,
  createMatrixUpdateKeepCredentialsPrompter,
  installMatrixOnboardingEnvRestoreHooks,
  createMatrixWizardPrompter,
  runMatrixAddAccountAllowlistConfigure,
  runMatrixInteractiveConfigure as configureMatrix,
} from "./onboarding.test-harness.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

vi.mock("./matrix/deps.js", () => ({
  ensureMatrixSdkInstalled: vi.fn(async () => {}),
  isMatrixSdkAvailable: vi.fn(() => true),
}));

function assertConfigured(
  result: Awaited<ReturnType<typeof configureMatrix>>,
): asserts result is Exclude<typeof result, "skip"> {
  expect(result).not.toBe("skip");
  if (result === "skip") {
    throw new Error("expected configured Matrix account");
  }
}

async function configure(
  params: Omit<Parameters<typeof configureMatrix>[0], "cfg"> & { cfg?: CoreConfig },
) {
  const result = await configureMatrix({
    cfg: createConfiguredMatrixTopLevelConfig(),
    configured: true,
    ...params,
  });
  assertConfigured(result);
  return result;
}

function invitePrompter(first: string, next = first) {
  const notes: string[] = [];
  let prompts = 0;
  const prompter = createMatrixUpdateKeepCredentialsPrompter({
    notes,
    inviteAutoJoin: "allowlist",
    onText: async (message) => {
      if (message !== "Matrix invite auto-join allowlist (comma-separated)") {
        throw new Error(`unexpected text prompt: ${message}`);
      }
      return ++prompts === 1 ? first : next;
    },
  });
  return { prompter, notes, count: () => prompts };
}

function authPrompter(
  authMode: string,
  text: Record<string, string>,
  confirm: Record<string, boolean> = {},
) {
  return createMatrixWizardPrompter({
    select: { "Matrix auth method": authMode },
    text: {
      "Matrix homeserver URL": "https://matrix.example.org",
      "Matrix device name (optional)": "",
      ...text,
    },
    confirm: { "Enable end-to-end encryption (E2EE)?": false, ...confirm },
    onConfirm: async () => false,
  });
}

function textPrompt(prompter: ReturnType<typeof createMatrixWizardPrompter>, message: string) {
  return vi.mocked(prompter.text).mock.calls.find(([options]) => options.message === message)?.[0];
}

describe("matrix onboarding", () => {
  installMatrixOnboardingEnvRestoreHooks();
  beforeEach(() => installMatrixTestRuntime());

  it("routes env-shortcut add-account flow through Matrix invite auto-join setup", async () => {
    installMatrixScopedEnvShortcut();

    const notes: string[] = [];
    const prompter = createMatrixEnvShortcutAddAccountPrompter({
      notes,
      select: {
        "Matrix rooms access": "allowlist",
        "Matrix invite auto-join": "allowlist",
      },
      text: {
        "Matrix rooms allowlist (comma-separated)": "!ops-room:example.org",
        "Matrix invite auto-join allowlist (comma-separated)": "#ops-invites:example.org",
      },
      confirm: {
        "Configure Matrix rooms access?": true,
        "Configure Matrix invite auto-join?": true,
      },
      onConfirm: (message) => message.startsWith("Matrix env vars detected"),
    });

    const result = await configure({
      cfg: createConfiguredMatrixDefaultAccountConfig(),
      prompter,
      shouldPromptAccountIds: true,
    });

    expect(result.accountId).toBe("ops");
    const opsAccount = result.cfg.channels?.matrix?.accounts?.ops;
    expect(opsAccount).toMatchObject({
      enabled: true,
      groupPolicy: "allowlist",
      autoJoin: "allowlist",
      groups: { "!ops-room:example.org": { enabled: true } },
      autoJoinAllowlist: ["#ops-invites:example.org"],
    });
    expect(opsAccount?.homeserver).toBeUndefined();
    expect(opsAccount?.accessToken).toBeUndefined();
    expect(notes.join("\n")).toContain("WARNING: Matrix invite auto-join defaults to off.");
    expect(textPrompt(prompter, "Matrix rooms allowlist (comma-separated)")?.placeholder).toBe(
      "!roomId:server, !roomId, #alias:server, Project Room",
    );
  });

  it("reuses an existing raw default-like key during onboarding promotion when defaultAccount is unset", async () => {
    const legacy = createLegacyMatrixTopLevelConfig();
    const support = {
      homeserver: "https://matrix.support.example.org",
      accessToken: "support-token",
    };
    const result = await configure({
      cfg: {
        ...legacy,
        channels: {
          matrix: {
            ...legacy.channels?.matrix,
            accounts: { Default: { enabled: true, deviceName: "Legacy raw key" }, support },
          },
        },
      } as CoreConfig,
      prompter: createMatrixTokenAddAccountPrompter(),
      shouldPromptAccountIds: true,
    });

    const defaultAccount = result.cfg.channels?.matrix?.accounts?.Default;
    expect(defaultAccount).toMatchObject({
      enabled: true,
      deviceName: "Legacy raw key",
      homeserver: "https://matrix.main.example.org",
      userId: "@main:example.org",
      accessToken: "main-token",
      avatarUrl: "mxc://matrix.main.example.org/main-avatar",
    });
    expect(result.cfg.channels?.matrix?.accounts?.default).toBeUndefined();
    expect(result.cfg.channels?.matrix?.accounts).toMatchObject({
      support,
      ops: { name: "ops", homeserver: "https://matrix.ops.example.org", accessToken: "ops-token" },
    });
  });

  it("prompts for private-network access when onboarding an internal http homeserver", async () => {
    const prompter = authPrompter(
      "token",
      {
        "Matrix homeserver URL": "http://localhost.localdomain:8008",
        "Matrix access token": "ops-token",
      },
      {
        "Allow private/internal Matrix homeserver traffic for this account?": true,
      },
    );

    const result = await configure({ cfg: {}, configured: false, prompter });

    expect(result.cfg.channels?.matrix).toMatchObject({
      homeserver: "http://localhost.localdomain:8008",
      accessToken: "ops-token",
      network: { dangerouslyAllowPrivateNetwork: true },
    });
  });

  it.each(["token", "password"])("marks the %s prompt as sensitive", async (authMode) => {
    const secretPrompt = authMode === "token" ? "Matrix access token" : "Matrix password";
    const prompter = authPrompter(authMode, {
      [secretPrompt]: `test-${authMode}`,
      ...(authMode === "password" ? { "Matrix user ID": "@test:example.org" } : {}),
    });

    await configure({ cfg: {}, configured: false, prompter });
    const prompt = textPrompt(prompter, secretPrompt);
    expect(prompt).toMatchObject({ message: secretPrompt, sensitive: true });
    expect(prompt).not.toHaveProperty("initialValue");
  });

  it("preserves SecretRef access tokens when keeping existing credentials", async () => {
    process.env.MATRIX_ACCESS_TOKEN = "env-token";

    const accessToken = { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" } as const;
    const result = await configure({
      cfg: {
        ...createConfiguredMatrixTopLevelConfig({ accessToken }),
        secrets: { defaults: { env: "default" } },
      } as CoreConfig,
      prompter: createMatrixUpdateKeepCredentialsPrompter(),
    });
    expect(result.cfg.channels?.matrix?.accessToken).toEqual(accessToken);
  });

  it("writes allowlists and room access to the selected Matrix account", async () => {
    const notes: string[] = [];

    const result = await runMatrixAddAccountAllowlistConfigure({
      cfg: createConfiguredMatrixDefaultAccountConfig(),
      allowFromInput: "@alice:example.org",
      roomsAllowlistInput: "!ops-room:example.org",
      autoJoinAllowlistInput: "#ops-invites:example.org",
      deviceName: "Ops Gateway",
      notes,
    });

    assertConfigured(result);

    expect(result.accountId).toBe("ops");
    expect(result.cfg.channels?.matrix?.accounts?.ops).toMatchObject({
      homeserver: "https://matrix.ops.example.org",
      accessToken: "ops-token",
      deviceName: "Ops Gateway",
      dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
      groupPolicy: "allowlist",
      autoJoin: "allowlist",
      autoJoinAllowlist: ["#ops-invites:example.org"],
      groups: { "!ops-room:example.org": { enabled: true } },
    });
    expect(result.cfg.channels?.["matrix"]?.dm).toBeUndefined();
    expect(result.cfg.channels?.["matrix"]?.groups).toBeUndefined();
    expect(notes.join("\n")).toContain("WARNING: Matrix invite auto-join defaults to off.");
  });

  it("clears Matrix invite auto-join allowlists when switching auto-join off", async () => {
    const notes: string[] = [];

    const result = await configure({
      cfg: createConfiguredMatrixTopLevelConfig({
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#ops:example.org"],
      }),
      prompter: createMatrixUpdateKeepCredentialsPrompter({ notes, inviteAutoJoin: "off" }),
    });

    expect(result.cfg.channels?.matrix?.autoJoin).toBe("off");
    expect(result.cfg.channels?.matrix?.autoJoinAllowlist).toBeUndefined();
    expect(notes.join("\n")).toContain("Matrix invite auto-join remains off.");
    expect(notes.join("\n")).toContain(
      "Agents will not join invited rooms or fresh DM-style invites until you change autoJoin.",
    );
  });

  it("re-prompts Matrix invite auto-join allowlists until entries are stable invite targets", async () => {
    const { prompter, notes, count } = invitePrompter("!, Project Room", "#ops:example.org");
    const result = await configure({ prompter });
    expect(count()).toBe(2);
    expect(result.cfg.channels?.matrix?.autoJoin).toBe("allowlist");
    expect(result.cfg.channels?.matrix?.autoJoinAllowlist).toEqual(["#ops:example.org"]);
    expect(notes.join("\n")).toContain(
      "Use only stable Matrix invite targets for auto-join: !roomId:server (or the suffixless !roomId form on room version 12+), #alias:server, or *.",
    );
    expect(notes.join("\n")).toContain("Invalid: !, Project Room");
  });

  it("accepts a room version 12 auto-join target (no :server suffix) on the first entry", async () => {
    // Room version 12 (MSC4291) dropped the trailing ":server" from room IDs.
    const { prompter, count } = invitePrompter("!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70");
    const result = await configure({ prompter });
    expect(count()).toBe(1);
    expect(result.cfg.channels?.matrix?.autoJoin).toBe("allowlist");
    expect(result.cfg.channels?.matrix?.autoJoinAllowlist).toEqual([
      "!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70",
    ]);
  });

  it("reports account-scoped DM config keys for named accounts", () => {
    const resolveConfigKeys = matrixOnboardingAdapter.dmPolicy?.resolveConfigKeys;
    if (resolveConfigKeys === undefined) {
      throw new Error("expected matrix DM policy config-key resolver");
    }

    expect(
      resolveConfigKeys(
        createMatrixNamedAccountsConfig({
          accounts: {
            default: { homeserver: "https://matrix.main.example.org" },
            ops: { homeserver: "https://matrix.ops.example.org" },
          },
        }),
        "ops",
      ),
    ).toEqual({
      policyKey: "channels.matrix.accounts.ops.dm.policy",
      allowFromKey: "channels.matrix.accounts.ops.dm.allowFrom",
    });
  });

  const namedAccount = (name: string) => ({
    homeserver: `https://matrix.${name}.example.org`,
    accessToken: `${name}-token`,
  });
  it.each([true, false])(
    "reports named-account status with explicit default=%s",
    async (selected) => {
      expect(
        await matrixOnboardingAdapter.getStatus({
          cfg: createMatrixNamedAccountsConfig({
            defaultAccount: selected ? "ops" : undefined,
            accounts: {
              ...(!selected ? { assistant: namedAccount("assistant") } : {}),
              ops: namedAccount("ops"),
            },
          }),
          accountOverrides: {},
        }),
      ).toMatchObject({
        configured: selected,
        selectionHint: selected ? "configured" : "set defaultAccount",
        statusLines: selected
          ? expect.arrayContaining(["Matrix: configured"])
          : ['Matrix: set "channels.matrix.defaultAccount" to select a named account'],
      });
    },
  );
});
