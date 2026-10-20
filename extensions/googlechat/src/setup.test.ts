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
import { googlechatPlugin } from "./channel.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

const hoisted = vi.hoisted(() => ({ startGoogleChatMonitor: vi.fn() }));
const startGoogleChatGatewayAccount = googlechatPlugin.gateway!.startAccount!;

// Keep real webhook URL resolution; stub only the monitor.
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
  meta: { label: "Google Chat" },
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

function alertsConfig(
  account: NonNullable<GoogleChatConfig["accounts"]>[string],
  root: GoogleChatConfig = {},
) {
  return withGoogleChat({ ...root, defaultAccount: "alerts", accounts: { alerts: account } });
}

function buildAccount(config: ResolvedGoogleChatAccount["config"] = {}): ResolvedGoogleChatAccount {
  return {
    accountId: "default",
    enabled: true,
    credentialSource: "inline",
    credentials: {},
    config: {
      webhookPath: "/googlechat",
      webhookUrl: "https://example.com/googlechat",
      ...audienceConfig,
      ...config,
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

  it.each([
    [DEFAULT_ACCOUNT_ID, "  ", 1, 0, "1"],
    ["alerts", "/tmp/googlechat.json", 0, 1, "0"],
  ] as const)("offers env credentials only to %s", async (id, file, confirms, selects, useEnv) => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '  {"client_email":"bot@example.com"}  ');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", file);
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "file" as const) as unknown as WizardPrompter["select"];
    const result = await googlechatSetupWizard.prepare!({
      cfg: {},
      accountId: id,
      credentialValues: {},
      prompter: createTestWizardPrompter({ confirm, select }),
    } as never);
    expect(confirm).toHaveBeenCalledTimes(confirms);
    expect(select).toHaveBeenCalledTimes(selects);
    expect(result?.credentialValues?.["__googlechatUseEnv"]).toBe(useEnv);
  });

  it.each([
    {
      name: "token-file and trimmed webhook fields",
      input: {
        tokenFile: "/tmp/googlechat.json",
        audienceType: " app-url ",
        audience: " https://example.com/googlechat ",
        webhookPath: " /googlechat ",
        webhookUrl: " https://example.com/googlechat/hook ",
      },
      patch: {
        serviceAccountFile: "/tmp/googlechat.json",
        audienceType: "app-url" as const,
        audience: "https://example.com/googlechat",
        webhookPath: "/googlechat",
        webhookUrl: "https://example.com/googlechat/hook",
      },
    },
    {
      name: "inline token without token-file",
      input: { token: { client_email: "bot@example.com" } },
      patch: { serviceAccount: { client_email: "bot@example.com" } },
    },
  ])("builds a patch from $name", ({ input, patch }) => {
    expect(
      googlechatSetupAdapter.applyAccountConfig!({
        cfg: withGoogleChat({}),
        accountId: DEFAULT_ACCOUNT_ID,
        input: { name: "Default", ...input },
      } as never),
    ).toEqual(withGoogleChat({ enabled: true, name: "Default", ...patch }));
  });

  it("configures service-account auth and webhook audience", async () => {
    const answers: Record<string, string> = {
      "Service account JSON path": "/tmp/googlechat-service-account.json",
      "App URL": "https://example.com/googlechat",
    };
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        const answer = answers[message];
        if (answer === undefined) {
          throw new Error(`Unexpected prompt: ${message}`);
        }
        return answer;
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
      ...audienceConfig,
    });
  });

  it("uses defaultAccount for DM policy reads and writes when accountId is omitted", () => {
    const cfg = alertsConfig({ dmPolicy: "allowlist" }, { dmPolicy: "disabled" });
    const dmPolicy = googlechatSetupWizard.dmPolicy!;
    expect(dmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(dmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.googlechat.accounts.alerts.dmPolicy",
      allowFromKey: "channels.googlechat.accounts.alerts.allowFrom",
    });
    const next = dmPolicy.setPolicy(cfg, "open").channels?.googlechat;
    expect(next?.allowFrom).toBeUndefined();
    expect(next).toMatchObject({
      dmPolicy: "disabled",
      accounts: { alerts: { dmPolicy: "open", allowFrom: ["*"] } },
    });
  });

  it("reports configured state for the configured defaultAccount instead of any account", async () => {
    const status = await googlechatStatus({
      cfg: withGoogleChat({
        defaultAccount: "alerts",
        accounts: {
          default: { serviceAccount: { client_email: "default@example.com" } },
          alerts: {},
        },
      }),
      accountOverrides: {},
      options: {},
    });

    expect(status.configured).toBe(false);
  });

  it("uses configured defaultAccount for omitted allowFrom prompt context", async () => {
    const next = await googlechatSetupWizard.dmPolicy?.promptAllowFrom?.({
      cfg: alertsConfig({ allowFrom: ["users/alerts"] }, { allowFrom: ["users/root"] }),
      prompter: createTestWizardPrompter({ text: vi.fn(async () => "users/123456789") }),
    });

    expect(next?.channels?.googlechat).toMatchObject({
      allowFrom: ["users/root"],
      accounts: { alerts: { allowFrom: ["users/123456789"] } },
    });
  });

  it("keeps startAccount pending until abort, then unregisters", async () => {
    const unregister = vi.fn();
    const waitForStarted = prepareGoogleChatMonitorStart(unregister);

    const lifecycle = startAccountAndTrackLifecycle({
      startAccount: startGoogleChatGatewayAccount,
      account: buildAccount(),
    });
    await expectPendingUntilAbort({
      waitForStarted,
      ...lifecycle,
      assertBeforeAbort: () => expect(unregister).not.toHaveBeenCalled(),
      assertAfterAbort: () => expect(unregister).toHaveBeenCalledOnce(),
    });
    expectLifecyclePatch(lifecycle.patches, {
      running: true,
      webhookPath: "/googlechat",
      lifecycle: "starting",
    });
    expectLifecyclePatch(lifecycle.patches, { running: false });
    expect(lifecycle.patches.some((patch) => patch.lifecycle === "blocked")).toBe(false);
  });

  it("clears a previously published webhook path when a restart resolves none", async () => {
    const resolvable = buildAccount({
      webhookPath: undefined,
      webhookUrl: "https://chat.example.com/gc-inbound",
    });
    // Both starts share the gateway's patch-merged status snapshot.
    const ctx = createStartAccountContext({ account: resolvable });
    const startAccount = ({
      account: nextAccount,
      abortSignal,
    }: Parameters<typeof startGoogleChatGatewayAccount>[0]) =>
      startGoogleChatGatewayAccount({ ...ctx, account: nextAccount, abortSignal });
    async function run(
      account: ResolvedGoogleChatAccount,
      expected: { webhookPath?: string; lifecycle?: string },
    ) {
      hoisted.startGoogleChatMonitor.mockClear();
      const waitForStarted = prepareGoogleChatMonitorStart();
      await expectPendingUntilAbort({
        ...startAccountAndTrackLifecycle({ startAccount, account }),
        waitForStarted,
        assertBeforeAbort: () => expect(ctx.getStatus()).toMatchObject(expected),
      });
    }
    await run(resolvable, { webhookPath: "/gc-inbound" });
    await run(buildAccount({ webhookPath: undefined, webhookUrl: "chat.example.com/gc-inbound" }), {
      lifecycle: "blocked",
      webhookPath: undefined,
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

    expect(resolved).toMatchObject({
      credentialSource: "env",
      credentials: undefined,
      credentialsFile: missingFile,
      tokenStatus: "configured_unavailable",
    });
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
    const timing = { windowSeconds: 120, cooldownSeconds: 240 };
    const cfg: GoogleChatConfig = {
      botLoopProtection: { maxEventsPerWindow: 8, ...timing },
      accounts: { april: { botLoopProtection: { maxEventsPerWindow: 3 } } },
    };
    const resolved = resolveAccount(cfg, "april");
    expect(resolved.config.botLoopProtection).toEqual({ maxEventsPerWindow: 3, ...timing });
  });

  it.each([
    { serviceAccount: { source: "env", provider: "test", id: "default-sa" } },
    { dangerouslyAllowNameMatching: true },
  ] as const)("does not inherit sensitive default-account settings: %j", (defaults) => {
    const cfg: GoogleChatConfig = {
      accounts: {
        default: { ...audienceConfig, ...defaults },
        andy: { serviceAccountFile: "/tmp/andy-sa.json" },
      },
    };
    const resolved = resolveAccount(cfg, "andy");
    expect(resolved.config.dangerouslyAllowNameMatching).toBeUndefined();
    expect(resolved).toMatchObject({
      credentialSource: "file",
      credentialsFile: "/tmp/andy-sa.json",
      config: { audienceType: "app-url" },
    });
  });
});
