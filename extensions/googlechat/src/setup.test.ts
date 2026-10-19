import fs from "node:fs";
import path from "node:path";
import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
  resolveDefaultGoogleChatAccountId,
  type ResolvedGoogleChatAccount,
} from "./accounts.js";
import { startGoogleChatGatewayAccount } from "./gateway.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

const hoisted = vi.hoisted(() => ({
  startGoogleChatMonitor: vi.fn(),
}));

// The path resolver stays real so the status assertions below cover the whole chain
// from configured webhookUrl to published snapshot; only the monitor is stubbed.
vi.mock("./channel.runtime.js", async () => {
  const monitor = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    googleChatChannelRuntime: {
      resolveGoogleChatWebhookPath: monitor.resolveGoogleChatWebhookPath,
      startGoogleChatMonitor: hoisted.startGoogleChatMonitor,
    },
  };
});

const googlechatSetupPlugin = {
  id: "googlechat",
  meta: {
    label: "Google Chat",
  },
  config: {
    defaultAccountId: resolveDefaultGoogleChatAccountId,
    listAccountIds: listGoogleChatAccountIds,
  },
  setupWizard: googlechatSetupWizard,
} as never;

const googlechatConfigure = createPluginSetupWizardConfigure(googlechatSetupPlugin);
const googlechatStatus = createPluginSetupWizardStatus(googlechatSetupPlugin);
type GoogleChatConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["googlechat"]>;
const audienceConfig = {
  audienceType: "app-url",
  audience: "https://example.com/googlechat",
} as const;

function withGoogleChat(googlechat: GoogleChatConfig): OpenClawConfig {
  return { channels: { googlechat } };
}

function resolveAccount(googlechat: GoogleChatConfig = {}, accountId = DEFAULT_ACCOUNT_ID) {
  return resolveGoogleChatAccount({ cfg: withGoogleChat(googlechat), accountId });
}

function resolveNamedAccount(defaults: NonNullable<GoogleChatConfig["accounts"]>[string]) {
  return resolveAccount(
    {
      accounts: {
        default: { ...audienceConfig, ...defaults },
        andy: { serviceAccountFile: "/tmp/andy-sa.json" },
      },
    },
    "andy",
  );
}

function alertsConfig(
  account: NonNullable<GoogleChatConfig["accounts"]>[string],
  root: GoogleChatConfig = {},
) {
  return withGoogleChat({ ...root, defaultAccount: "alerts", accounts: { alerts: account } });
}

function applyConfig(
  input: Parameters<NonNullable<typeof googlechatSetupAdapter.applyAccountConfig>>[0]["input"],
) {
  return googlechatSetupAdapter.applyAccountConfig!({
    cfg: withGoogleChat({}),
    accountId: DEFAULT_ACCOUNT_ID,
    input,
  });
}

async function prepare(accountId: string) {
  const confirm = vi.fn(async () => true);
  const select = vi.fn(async () => "file" as const) as unknown as WizardPrompter["select"];
  const result = await googlechatSetupWizard.prepare!({
    cfg: {},
    accountId,
    credentialValues: {},
    prompter: createTestWizardPrompter({ confirm, select }),
  } as never);
  return { confirm, select, result };
}

function buildAccount(): ResolvedGoogleChatAccount {
  return {
    accountId: "default",
    enabled: true,
    credentialSource: "inline",
    credentials: {},
    config: {
      webhookPath: "/googlechat",
      webhookUrl: "https://example.com/googlechat",
      ...audienceConfig,
    },
  };
}

function prepareGoogleChatMonitorStart(unregister = vi.fn()) {
  const started = createDeferred<void>();
  hoisted.startGoogleChatMonitor.mockImplementation(async () => {
    started.resolve();
    return unregister;
  });
  return async () => {
    await started.promise;
    expect(hoisted.startGoogleChatMonitor).toHaveBeenCalledOnce();
  };
}

describe("googlechat setup", () => {
  beforeAll(async () => {
    // Keep cold monitor imports out of the lifecycle assertion's wait budget.
    await import("./channel.runtime.js");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("./channel.runtime.js");
    vi.resetModules();
  });

  it("rejects env auth for non-default accounts", () => {
    expect(
      googlechatSetupAdapter.validateInput!({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.");
  });

  it("offers valid service-account env credentials for the default account", async () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '  {"client_email":"bot@example.com"}  ');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "  ");
    const { confirm, select, result } = await prepare(DEFAULT_ACCOUNT_ID);

    expect(confirm).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(result?.credentialValues?.["__googlechatUseEnv"]).toBe("1");
  });

  it("does not offer default-account env credentials to named accounts", async () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '{"client_email":"bot@example.com"}');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "/tmp/googlechat.json");
    const { confirm, select, result } = await prepare("alerts");

    expect(confirm).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledOnce();
    expect(result?.credentialValues?.["__googlechatUseEnv"]).toBe("0");
  });

  it("builds a patch from token-file and trims optional webhook fields", () => {
    expect(
      applyConfig({
        name: "Default",
        tokenFile: "/tmp/googlechat.json",
        audienceType: " app-url ",
        audience: " https://example.com/googlechat ",
        webhookPath: " /googlechat ",
        webhookUrl: " https://example.com/googlechat/hook ",
      } as never),
    ).toEqual(
      withGoogleChat({
        enabled: true,
        name: "Default",
        serviceAccountFile: "/tmp/googlechat.json",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
        webhookPath: "/googlechat",
        webhookUrl: "https://example.com/googlechat/hook",
      }),
    );
  });

  it("prefers inline token patch when token-file is absent", () => {
    expect(
      applyConfig({
        name: "Default",
        token: { client_email: "bot@example.com" },
      } as never),
    ).toEqual(
      withGoogleChat({
        enabled: true,
        name: "Default",
        serviceAccount: { client_email: "bot@example.com" },
      }),
    );
  });

  it("configures service-account auth and webhook audience", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Service account JSON path") {
          return "/tmp/googlechat-service-account.json";
        }
        if (message === "App URL") {
          return "https://example.com/googlechat";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: googlechatConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.googlechat).toMatchObject({
      enabled: true,
      serviceAccountFile: "/tmp/googlechat-service-account.json",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });
  });

  it("uses defaultAccount for DM policy reads and writes when accountId is omitted", () => {
    const cfg = alertsConfig(
      { serviceAccount: { client_email: "bot@example.com" }, dmPolicy: "allowlist" },
      { dmPolicy: "disabled" },
    );
    const dmPolicy = googlechatSetupWizard.dmPolicy!;
    expect(dmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(dmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.googlechat.accounts.alerts.dmPolicy",
      allowFromKey: "channels.googlechat.accounts.alerts.allowFrom",
    });
    const next = dmPolicy.setPolicy(cfg, "open");
    expect(next.channels?.googlechat?.dmPolicy).toBe("disabled");
    expect(next.channels?.googlechat?.allowFrom).toBeUndefined();
    expect(next.channels?.googlechat?.accounts?.alerts).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
  });

  it("reports configured state for the configured defaultAccount instead of any account", async () => {
    const status = await googlechatStatus({
      cfg: withGoogleChat({
        defaultAccount: "alerts",
        accounts: {
          default: {
            serviceAccount: { client_email: "default@example.com" },
          },
          alerts: {},
        },
      }),
      accountOverrides: {},
      options: {},
    });

    expect(status.configured).toBe(false);
  });

  it("uses configured defaultAccount for omitted allowFrom prompt context", async () => {
    const prompter = createTestWizardPrompter({
      note: vi.fn(async () => {}),
      text: vi.fn(async () => "users/123456789"),
    });

    const next = await googlechatSetupWizard.dmPolicy?.promptAllowFrom?.({
      cfg: alertsConfig(
        { serviceAccount: { client_email: "bot@example.com" }, allowFrom: ["users/alerts"] },
        { allowFrom: ["users/root"] },
      ),
      prompter,
    });

    expect(next?.channels?.googlechat?.allowFrom).toEqual(["users/root"]);
    expect(next?.channels?.googlechat?.accounts?.alerts?.allowFrom).toEqual(["users/123456789"]);
  });

  it("keeps startAccount pending until abort, then unregisters", async () => {
    const unregister = vi.fn();
    const waitForStarted = prepareGoogleChatMonitorStart(unregister);

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: startGoogleChatGatewayAccount,
      account: buildAccount(),
    });
    await expectPendingUntilAbort({
      waitForStarted,
      isSettled,
      abort,
      task,
      assertBeforeAbort: () => {
        expect(unregister).not.toHaveBeenCalled();
      },
      assertAfterAbort: () => {
        expect(unregister).toHaveBeenCalledOnce();
      },
    });
    expectLifecyclePatch(patches, {
      running: true,
      webhookPath: "/googlechat",
      lifecycle: "starting",
    });
    expectLifecyclePatch(patches, { running: false });
    expect(patches.some((patch) => patch.lifecycle === "blocked")).toBe(false);
  });

  it("clears a previously published webhook path when a restart resolves none", async () => {
    const waitForFirstStart = prepareGoogleChatMonitorStart();
    const account = buildAccount();
    const resolvable = {
      ...account,
      config: {
        ...account.config,
        webhookPath: undefined,
        webhookUrl: "https://chat.example.com/gc-inbound",
      },
    };
    // One context, so both starts write through the same status snapshot the way
    // the gateway's runtime store patch-merges successive plugin patches.
    const ctx = createStartAccountContext({ account: resolvable });
    const startAccount = ({
      account: nextAccount,
      abortSignal,
    }: Parameters<typeof startGoogleChatGatewayAccount>[0]) =>
      startGoogleChatGatewayAccount({ ...ctx, account: nextAccount, abortSignal });
    const first = startAccountAndTrackLifecycle({ startAccount, account: resolvable });
    await expectPendingUntilAbort({
      ...first,
      waitForStarted: waitForFirstStart,
      assertBeforeAbort: () => {
        expect(ctx.getStatus().webhookPath).toBe("/gc-inbound");
      },
    });

    hoisted.startGoogleChatMonitor.mockClear();
    const waitForSecondStart = prepareGoogleChatMonitorStart();
    const second = startAccountAndTrackLifecycle({
      startAccount,
      account: {
        ...resolvable,
        config: { ...resolvable.config, webhookUrl: "chat.example.com/gc-inbound" },
      },
    });
    await expectPendingUntilAbort({
      ...second,
      waitForStarted: waitForSecondStart,
      assertBeforeAbort: () => {
        const restarted = ctx.getStatus();
        expect(restarted.lifecycle).toBe("blocked");
        expect(restarted.webhookPath).toBeUndefined();
      },
    });
  });
});

describe("resolveGoogleChatAccount", () => {
  const tempWorkspaces: TempWorkspaceSync[] = [];

  function workspace(prefix: string) {
    const created = tempWorkspaceSync({ rootDir: resolvePreferredOpenClawTmpDir(), prefix });
    tempWorkspaces.push(created);
    return created.dir;
  }

  afterEach(() => {
    for (const created of tempWorkspaces.splice(0)) {
      created.cleanup();
    }
  });

  it("resolves user-relative service-account files before checking availability", () => {
    const homeDir = workspace("openclaw-googlechat-home-");
    fs.writeFileSync(path.join(homeDir, "service-account.json"), "{}", { mode: 0o600 });
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    try {
      expect(resolveAccount({ serviceAccountFile: "~/service-account.json" })).toMatchObject({
        credentialSource: "file",
        credentialsFile: "~/service-account.json",
        tokenStatus: "available",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parses default-account env JSON credentials only when they decode to an object", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '{"client_email":"bot@example.com"}');
    const resolved = resolveAccount();
    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toEqual({ client_email: "bot@example.com" });
  });

  it("ignores env JSON credentials when they decode to a non-object value", () => {
    const missingFile = path.join(workspace("openclaw-googlechat-missing-"), "missing.json");
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '["not","an","object"]');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", missingFile);

    const resolved = resolveAccount();

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toBeUndefined();
    expect(resolved.credentialsFile).toBe(missingFile);
    expect(resolved.tokenStatus).toBe("configured_unavailable");
    expect(resolved.credentialDiagnostics).toEqual([
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE",
        reason: "not-found",
      },
    ]);
    expect(JSON.stringify(resolved.credentialDiagnostics)).not.toContain(missingFile);
  });

  it("merges account bot loop protection over top-level defaults field-by-field", () => {
    const resolved = resolveAccount(
      {
        botLoopProtection: {
          maxEventsPerWindow: 8,
          windowSeconds: 120,
          cooldownSeconds: 240,
        },
        accounts: {
          april: {
            webhookPath: "/googlechat-april",
            botLoopProtection: {
              maxEventsPerWindow: 3,
            },
          },
        },
      },
      "april",
    );
    expect(resolved.config.botLoopProtection).toEqual({
      maxEventsPerWindow: 3,
      windowSeconds: 120,
      cooldownSeconds: 240,
    });
  });

  it("does not inherit default-account credentials into named accounts", () => {
    const resolved = resolveNamedAccount({
      serviceAccount: { source: "env", provider: "test", id: "default-sa" },
    });
    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/tmp/andy-sa.json");
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit dangerous name matching from accounts.default", () => {
    const resolved = resolveNamedAccount({ dangerouslyAllowNameMatching: true });
    expect(resolved.config.dangerouslyAllowNameMatching).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });
});
