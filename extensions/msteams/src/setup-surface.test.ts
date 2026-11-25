import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMSTeamsSetupWizardBase,
  msteamsSetupAdapter,
  msteamsSetupContract,
} from "./setup-core.js";
import { createMSTeamsSetupPrompter, createMSTeamsTestConfig } from "./setup.test-support.js";

const hasConfiguredMSTeamsCredentials = vi.hoisted(() => vi.fn());
const resolveMSTeamsCredentials = vi.hoisted(() => vi.fn());

const secret = { appId: "support-app", appPassword: "support-secret", tenantId: "tenant-id" };
const oldSecret = { appId: "old-app", appPassword: "old-secret", tenantId: "old-tenant" };
const federated = {
  authType: "federated" as const,
  appId: "support-app",
  tenantId: "tenant-id",
  certificatePath: "/secure/support.pem",
};
const federatedCredentials = {
  type: "federated",
  appId: "support-app",
  tenantId: "tenant-id",
  certificatePath: "/secure/support.pem",
};
const webhook = { path: "/hooks/3979" };
const envFederated = {
  type: "federated",
  appId: "env-app",
  tenantId: "env-tenant",
  certificatePath: "/secure/env.pem",
};
const storedSecret = {
  appId: "stored-app",
  appPassword: "stored-password",
  tenantId: "stored-tenant",
};
function namedConfig(
  account: NonNullable<Parameters<typeof createMSTeamsTestConfig>[0]["accounts"]>[string],
  key = "support",
  root: Parameters<typeof createMSTeamsTestConfig>[0] = {},
) {
  return createMSTeamsTestConfig({ ...root, accounts: { [key]: account } });
}

vi.mock("./token-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token-config.js")>()),
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials,
}));

describe("msteams setup surface", () => {
  const msteamsSetupWizard = createMSTeamsSetupWizardBase();
  type Config = Parameters<typeof createMSTeamsTestConfig>[0];
  type Input = Parameters<typeof msteamsSetupAdapter.applyAccountConfig>[0]["input"];
  const validate = (input: Input, cfg = createMSTeamsTestConfig({}), accountId = "support") =>
    msteamsSetupContract.validateInput?.({ cfg, accountId, input });
  const apply = (input: Input, cfg = createMSTeamsTestConfig({}), accountId = "support") =>
    msteamsSetupContract.applyAccountConfig({ cfg, accountId, input });
  const applyAdapter = (
    input: Input,
    cfg: ReturnType<typeof createMSTeamsTestConfig>,
    accountId = "support",
  ) => msteamsSetupAdapter.applyAccountConfig?.({ cfg, accountId, input });
  const finalize = (
    prompter: ReturnType<typeof createMSTeamsSetupPrompter>,
    cfg = createMSTeamsTestConfig({}),
    accountId?: string,
  ) => msteamsSetupWizard.finalize?.({ cfg, accountId, prompter } as never);
  const configured = (accounts: Config["accounts"], root: Config = {}) =>
    createMSTeamsTestConfig({ ...root, enabled: true, accounts });

  beforeEach(() => {
    hasConfiguredMSTeamsCredentials.mockReset();
    resolveMSTeamsCredentials.mockReset();
  });

  it("resolves the requested account id", () => {
    expect(msteamsSetupAdapter.resolveAccountId?.({ cfg: {}, accountId: "work" })).toBe("work");
  });

  it("enables the msteams channel and promotes existing default identity", () => {
    const cfg = createMSTeamsTestConfig({ appId: "existing-app" });
    expect(applyAdapter({}, cfg, DEFAULT_ACCOUNT_ID)).toEqual(
      configured({ default: { enabled: true, appId: "existing-app" } }),
    );
  });

  it("updates an existing display-style account key in place", () => {
    const result = applyAdapter(
      secret,
      namedConfig({ name: "Support Bot", enabled: false, ...oldSecret, webhook }, "Support Bot"),
      "support-bot",
    );

    expect(result?.channels?.msteams?.accounts).toEqual({
      "Support Bot": {
        name: "Support Bot",
        enabled: true,
        ...secret,
        authType: "secret",
        webhook,
      },
    });
    expect(result?.channels?.msteams?.accounts).not.toHaveProperty("support-bot");
  });

  it("updates a display-style default alias without creating a duplicate key", () => {
    const input = { ...secret, appId: "new-app", appPassword: "new-secret" };
    const cfg = namedConfig({ appId: "old-app", appPassword: "old-secret", webhook }, "Default", {
      tenantId: "tenant-id",
    });
    const result = applyAdapter(input, cfg, "default");

    expect(result?.channels?.msteams?.accounts).toEqual({
      Default: {
        enabled: true,
        ...input,
        authType: "secret",
        webhook,
      },
    });
    expect(result?.channels?.msteams?.accounts).not.toHaveProperty("default");
  });

  it("updates an explicit default account webhook path without changing the shared root", () => {
    const result = applyAdapter(
      { webhookPath: "/hooks/4978" },
      namedConfig({ ...secret, webhook: { path: "/default/messages" } }, "Default", {
        webhook: { path: "/root/messages" },
      }),
      "default",
    );

    expect(result?.channels?.msteams?.webhook).toEqual({ path: "/root/messages" });
    expect(result?.channels?.msteams?.accounts?.Default?.webhook).toEqual({
      path: "/hooks/4978",
    });
  });

  it("rejects env credentials for named accounts", () => {
    expect(validate({ useEnv: true })).toBe(
      "MSTEAMS_* environment variables can only be used for the default account.",
    );
  });

  it("rejects whitespace-only noninteractive credentials", () => {
    expect(
      validate(
        { appId: " ", appPassword: "\t", tenantId: "\n" },
        createMSTeamsTestConfig({}),
        "default",
      ),
    ).toBe(
      "MS Teams requires appId, appPassword, and tenantId (or --use-env for the default account).",
    );
  });

  it("stores a webhook path supplied by noninteractive named-account setup", () => {
    expect(msteamsSetupContract.parseInput(secret)).toEqual({ ok: true, value: secret });
    expect(validate(secret)).toBeNull();
    const input = { ...secret, webhookPath: webhook.path };
    expect(validate(input)).toBeNull();
    expect(apply(input).channels?.msteams?.accounts?.support).toEqual({
      enabled: true,
      ...secret,
      authType: "secret",
      webhook,
    });
  });

  it("accepts new named-account credentials with an inherited root tenant", () => {
    const cfg = createMSTeamsTestConfig({
      tenantId: "shared-tenant",
      authType: "federated" as const,
      certificatePath: "/secure/shared.pem",
    });
    const { tenantId: _tenantId, ...credentials } = secret;
    const input = { ...credentials, webhookPath: webhook.path };
    hasConfiguredMSTeamsCredentials.mockImplementation(
      (candidate: { appId?: string; appPassword?: string; tenantId?: string }) =>
        Boolean(candidate.appId && candidate.appPassword && candidate.tenantId),
    );

    expect(validate(input, cfg)).toBeNull();
    expect(hasConfiguredMSTeamsCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        ...credentials,
        tenantId: "shared-tenant",
        authType: "secret",
      }),
      { allowEnvFallback: false },
    );
    expect(apply(input, cfg).channels?.msteams?.accounts?.support).toEqual({
      enabled: true,
      ...credentials,
      authType: "secret",
      webhook,
    });
  });

  it.each([
    { account: secret, path: "/support/messages" },
    { account: federated, path: webhook.path },
  ])(
    "preserves credentials during a partial noninteractive update from $path",
    ({ account, path }) => {
      const cfg = namedConfig({ ...account, webhook: { path } });
      hasConfiguredMSTeamsCredentials.mockReturnValue(true);
      expect(validate({ webhookPath: "/hooks/3980" }, cfg)).toBeNull();
      expect(hasConfiguredMSTeamsCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ appId: "support-app" }),
        { allowEnvFallback: false },
      );
      expect(
        apply({ webhookPath: "/hooks/3980" }, cfg).channels?.msteams?.accounts?.support,
      ).toEqual({ enabled: true, ...account, webhook: { path: "/hooks/3980" } });
    },
  );

  it.each([
    [{ appId: "app" }, false],
    [null, true],
  ])("reports configured status from resolved=%j, configured=%s", (resolved, hasConfig) => {
    resolveMSTeamsCredentials.mockReturnValue(resolved);
    hasConfiguredMSTeamsCredentials.mockReturnValue(hasConfig);
    expect(msteamsSetupWizard.status.resolveConfigured({ cfg: {} } as never)).toBe(true);
  });

  it("renders unconfigured status lines", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    await expect(
      msteamsSetupWizard.status.resolveStatusLines?.({ cfg: {} } as never),
    ).resolves.toEqual(["MS Teams: needs app credentials"]);
  });

  it("finalize keeps accepted environment credentials without persisting them", async () => {
    resolveMSTeamsCredentials.mockReturnValue(envFederated);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter();
    const result = await msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: { existing: true } } },
      prompter,
    } as never);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Microsoft Teams environment credentials detected. Use env vars?",
      initialValue: true,
    });
    expect(result?.accountId).toBe("default");
    expect(result?.cfg?.channels?.msteams).toEqual({
      existing: true,
      enabled: true,
      accounts: { default: { enabled: true } },
    });
  });

  it("finalize overrides federated environment auth when writing a new password", async () => {
    resolveMSTeamsCredentials.mockReturnValue(envFederated);
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const prompter = createMSTeamsSetupPrompter(["new-app", "new-password", "new-tenant"]);

    const result = await finalize(prompter, createMSTeamsTestConfig({}), "default");

    expect(result?.cfg?.channels?.msteams?.accounts?.default).toMatchObject({
      authType: "secret",
      appId: "new-app",
      appPassword: "new-password",
      tenantId: "new-tenant",
    });
  });

  it("finalize re-enables an account-scoped default when keeping its credentials", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "default-app",
      appPassword: "default-secret",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const prompter = createMSTeamsSetupPrompter();

    const result = await finalize(
      prompter,
      namedConfig(
        { enabled: false, appId: "default-app", appPassword: "default-secret", webhook },
        "Default",
        { tenantId: "tenant-id", defaultAccount: "Default" },
      ),
      "default",
    );

    expect(result?.cfg?.channels?.msteams?.accounts?.Default?.enabled).toBe(true);
    expect(result?.cfg?.channels?.msteams?.accounts).not.toHaveProperty("default");
  });

  it("finalize enables accepted persisted credentials without rewriting them", async () => {
    resolveMSTeamsCredentials.mockReturnValue({ type: "secret", ...storedSecret });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const prompter = createMSTeamsSetupPrompter();
    const { confirm, text } = prompter;

    const result = await finalize(
      prompter,
      createMSTeamsTestConfig({ enabled: false, ...storedSecret }),
    );

    expect(confirm).toHaveBeenCalledWith({
      message: "MS Teams credentials already configured. Keep them?",
      initialValue: true,
    });
    expect(text).not.toHaveBeenCalled();
    const { tenantId, ...identity } = storedSecret;
    expect(result).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg: configured({ default: { enabled: true, ...identity } }, { tenantId }),
    });
  });

  it("finalize prompts for manual credentials when env/config creds are unavailable", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter(["app-id", "app-password", "tenant-id"]);
    const { note } = prompter;

    const result = await finalize(prompter);

    expect(note).toHaveBeenCalled();
    expect(result?.cfg?.channels?.msteams?.accounts?.default).toEqual({
      enabled: true,
      appId: "app-id",
      appPassword: "app-password",
      authType: "secret",
      tenantId: "tenant-id",
    });
  });

  it("finalize configures named accounts with credentials without requiring a listener", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter(["support-app", "support-password", "tenant-id"]);

    const root = {
      tenantId: "shared-tenant",
      webhook: { path: "/api/messages" },
      dmPolicy: "allowlist" as const,
      allowFrom: ["user-1"],
    };
    const result = await finalize(prompter, createMSTeamsTestConfig(root), "support");

    expect(result).toEqual({
      accountId: "support",
      cfg: configured(
        {
          support: {
            enabled: true,
            appId: "support-app",
            appPassword: "support-password",
            authType: "secret",
            tenantId: "tenant-id",
          },
        },
        root,
      ),
    });
  });

  it("finalize keeps existing federated named account credentials", async () => {
    resolveMSTeamsCredentials.mockReturnValue(federatedCredentials);
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const prompter = createMSTeamsSetupPrompter();
    const { confirm, text } = prompter;

    const result = await finalize(prompter, namedConfig({ ...federated, webhook }), "support");

    expect(result?.cfg?.channels?.msteams?.accounts?.support).toEqual({
      ...federated,
      webhook,
      enabled: true,
    });
    expect(confirm).toHaveBeenCalledWith({
      message: "MS Teams credentials already configured. Keep them?",
      initialValue: true,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("finalize switches replaced federated credentials to secret auth", async () => {
    resolveMSTeamsCredentials.mockReturnValue(federatedCredentials);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter(["new-app", "new-password", "tenant-id"]);

    const result = await finalize(prompter, namedConfig({ ...federated, webhook }), "support");

    const account = result?.cfg?.channels?.msteams?.accounts?.support;
    expect(account).toMatchObject({
      authType: "secret",
      appId: "new-app",
      appPassword: "new-password",
    });
    expect(account?.certificatePath).toBeUndefined();
  });
});
