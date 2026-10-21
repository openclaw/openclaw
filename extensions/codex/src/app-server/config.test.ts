import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-runtime.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  codexSandboxPolicyForTurn,
  readCodexPluginConfig,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexSupervisionAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexPluginsPolicy,
  shouldAutoApproveCodexAppServerApprovals,
} from "./config.js";
import { expectFields, expectRuntimePolicy, resolveRuntimeForTest } from "./config.test-support.js";

const fullAccessPolicy = {
  approvalPolicy: "never",
  sandbox: "danger-full-access",
  approvalsReviewer: "user",
} as const;
const autoReviewPolicy = {
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  approvalsReviewer: "auto_review",
};
const userReviewPolicy = { ...autoReviewPolicy, approvalsReviewer: "user" };
const readOnlyAutoReviewPolicy = { ...autoReviewPolicy, sandbox: "read-only" };
const readOnlyUserReviewPolicy = { ...userReviewPolicy, sandbox: "read-only" };
const perCommandPolicy = { ...fullAccessPolicy, approvalPolicy: "untrusted" };
type RuntimeParams = NonNullable<Parameters<typeof resolveRuntimeForTest>[0]>;
type RuntimePolicy = Parameters<typeof expectRuntimePolicy>[1];
type Approvals = NonNullable<NonNullable<Parameters<typeof resolveExecPolicy>[1]>["approvals"]>;
const approvals = (
  defaults: Approvals["defaults"],
  agents: Approvals["agents"] = {},
): Approvals => ({ version: 1, defaults, agents });
const localUrl = "ws://127.0.0.1:39175";
const remoteUrl = "wss://codex-app-server.example.internal/ws";
const restrictedSandbox = 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
const legacyAsk = resolveExecPolicy({ security: "full", ask: "always" });
const plugin = (appServer: unknown): RuntimeParams => ({ pluginConfig: { appServer } });
const yolo = { mode: "yolo", ...fullAccessPolicy };
const inlineCommand =
  "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";

function resolveAppServer(appServer: unknown, options: Omit<RuntimeParams, "pluginConfig"> = {}) {
  return resolveRuntimeForTest({ ...options, pluginConfig: { appServer } });
}

function resolveExecPolicy(
  exec: NonNullable<NonNullable<OpenClawConfig["tools"]>["exec"]>,
  options: Omit<Parameters<typeof resolveOpenClawExecPolicyForCodexAppServer>[0], "config"> = {},
) {
  return resolveOpenClawExecPolicyForCodexAppServer({ ...options, config: { tools: { exec } } });
}

const computerUseDefaults = {
  enabled: true,
  marketplaceDiscoveryTimeoutMs: 60_000,
  liveTestTimeoutMs: 60_000,
  toolCallTimeoutMs: 60_000,
  healthCheckEnabled: false,
  healthCheckIntervalMinutes: 60,
  pluginCacheMode: "independent",
  strictReadiness: false,
  autoRepair: false,
};
const canUseReviewer = (
  context: Parameters<typeof canUseCodexModelBackedApprovalsReviewerForModel>[0] = {},
) =>
  canUseCodexModelBackedApprovalsReviewerForModel({
    modelProvider: "openai",
    model: "gpt-5.5",
    ...context,
  });
const baseOpenai = { baseUrl: "https://api.openai.com/v1", models: [] };
const proxyHeaders = { "x-openclaw-reviewer-proxy": "local" };
const marketplacePlugin = (pluginName: string) => ({
  marketplaceName: "openai-curated",
  pluginName,
});
const pluginPolicy = (configKey: string, enabled: boolean, mode: "allow" | "auto" | "deny") => ({
  ...marketplacePlugin(configKey),
  configKey,
  enabled,
  allowDestructiveActions: mode !== "deny",
  destructiveApprovalMode: mode,
});
const clientStart = {
  transport: "websocket",
  command: "codex",
  args: [],
  headers: {},
  url: localUrl,
} satisfies Parameters<typeof codexAppServerStartOptionsKey>[0];

describe("Codex app-server config", () => {
  it.each<[string, RuntimeParams, RuntimePolicy]>([
    [
      "allows environment guardian mode with native TOML endpoint syntax",
      {
        modelProvider: "openai",
        codexConfigToml: String.raw`openai_base_url = """https://api.\u006fpenai.com/v1"""`,
        env: { OPENCLAW_CODEX_APP_SERVER_MODE: "guardian" },
      },
      autoReviewPolicy,
    ],
    [
      "forces guarded app-server policy fields for auto mode",
      {
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            approvalsReviewer: "user",
          },
        },
        env: {
          OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
          OPENCLAW_CODEX_APP_SERVER_SANDBOX: "danger-full-access",
        },
        execMode: "auto",
        modelProvider: "openai",
      },
      autoReviewPolicy,
    ],
    [
      "prefers the normalized on-request alias over a permitted never policy",
      {
        execMode: "auto",
        requirementsToml:
          'allowed_sandbox_modes = ["danger-full-access", "read-only"]\nallowed_approval_policies = ["never", "on-failure"]\nallowed_approvals_reviewers = ["user"]\n',
      },
      readOnlyUserReviewPolicy,
    ],
    [
      "forces prompting when explicit no-prompt config cannot use model-backed review",
      {
        ...plugin({ ...fullAccessPolicy, mode: "guardian", approvalsReviewer: "auto_review" }),
        modelProvider: "lmstudio",
        model: "local-model",
      },
      userReviewPolicy,
    ],
    [
      "preserves explicit read-only app-server sandbox for auto mode",
      {
        ...plugin({ ...yolo, sandbox: "read-only" }),
        execMode: "auto",
        modelProvider: "openai",
        env: {},
      },
      readOnlyAutoReviewPolicy,
    ],
    [
      "preserves explicit read-only app-server sandbox for ask mode",
      {
        execMode: "ask",
        env: {
          OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
          OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
          OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
        },
      },
      readOnlyUserReviewPolicy,
    ],
    [
      "honors managed prompting approvals for auto mode",
      {
        execMode: "auto",
        modelProvider: "openai",
        requirementsToml: 'allowed_approval_policies = ["untrusted", "never"]',
      },
      { ...autoReviewPolicy, approvalPolicy: "untrusted" },
    ],
    [
      "honors managed policy that permits mandatory per-command approvals",
      {
        execPolicy: legacyAsk,
        requirementsToml: 'allowed_approval_policies = ["on-request", "untrusted"]',
      },
      perCommandPolicy,
    ],
    [
      "clamps legacy full exec with ask when an OpenClaw sandbox is active",
      {
        execPolicy: legacyAsk,
        openClawSandboxActive: true,
        requirementsToml: restrictedSandbox,
      },
      { ...userReviewPolicy, approvalPolicy: "untrusted" },
    ],
  ])("%s", (_name, params, policy) => {
    const runtime = resolveRuntimeForTest(params);
    expectRuntimePolicy(runtime, policy);
    expect(shouldAutoApproveCodexAppServerApprovals(runtime)).toBe(false);
  });

  it.each<[string, RuntimeParams, string]>([
    [
      "rejects additional session homes for websocket app servers",
      {
        pluginConfig: {
          appServer: { transport: "websocket", url: localUrl },
          sessionCatalog: { homes: ["/srv/codex-extra"] },
        },
      },
      "plugins.entries.codex.config.sessionCatalog.homes requires appServer.transport=stdio",
    ],
    [
      "rejects remote websocket app-servers without identity-bearing auth",
      plugin({ transport: "websocket", url: remoteUrl }),
      "remote Codex app-server WebSocket URLs require appServer.authToken or an Authorization header",
    ],
    [
      "rejects Unix app-server connections outside the shared user home",
      plugin({ transport: "unix", homeScope: "agent" }),
      "plugins.entries.codex.config.appServer.transport=unix requires appServer.homeScope=user",
    ],
    [
      "rejects non-Unix URLs for Unix app-server connections",
      plugin({ transport: "unix", homeScope: "user", url: localUrl }),
      "plugins.entries.codex.config.appServer.url must use unix:// when appServer.transport is unix",
    ],
    [
      "fails closed when Guardian local-model fallback needs user approvals but requirements disallow them",
      {
        ...plugin({ mode: "guardian" }),
        modelProvider: "lmstudio",
        model: "local-model",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
      },
      "tools.exec.mode=ask requires Codex app-server user approvals",
    ],
    [
      "fails closed when ask mode can only use never approvals",
      { execMode: "ask", requirementsToml: 'allowed_approval_policies = ["never"]' },
      "tools.exec.mode=ask requires Codex app-server prompting approvals",
    ],
    [
      "fails closed when legacy full exec with ask cannot use full Codex sandbox",
      {
        execPolicy: legacyAsk,
        requirementsToml: restrictedSandbox,
      },
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    ],
    [
      "fails closed when managed policy forbids mandatory per-command approvals",
      {
        execPolicy: legacyAsk,
        requirementsToml: 'allowed_approval_policies = ["on-request", "never"]',
      },
      "tools.exec.ask=always requires Codex app-server per-command approvals",
    ],
  ])("%s", (_name, params, error) => {
    expect(() => resolveRuntimeForTest(params)).toThrow(error);
  });

  it("only auto-approves app-server approvals for full yolo runtime policy", () => {
    expect(shouldAutoApproveCodexAppServerApprovals(fullAccessPolicy)).toBe(true);
    expect(
      shouldAutoApproveCodexAppServerApprovals({ ...fullAccessPolicy, sandbox: "workspace-write" }),
    ).toBe(false);
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        ...fullAccessPolicy,
        approvalPolicy: "on-request",
      }),
    ).toBe(false);
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        ...fullAccessPolicy,
        networkProxy: {
          profileName: "openclaw-network",
          configFingerprint: "network-proxy-v1",
          configPatch: {
            "features.network_proxy.enabled": true,
            default_permissions: "openclaw-network",
            permissions: {},
          },
        },
      }),
    ).toBe(false);
  });

  it("parses typed plugin config before falling back to environment knobs", () => {
    const runtime = resolveAppServer(
      {
        mode: "guardian",
        transport: "websocket",
        url: localUrl,
        headers: { "X-Test": "yes" },
        approvalPolicy: "on-failure",
        sandbox: "danger-full-access",
        approvalsReviewer: "guardian_subagent",
        serviceTier: "flex",
        codeModeOnly: true,
        loopDetectionPreToolUseRelay: false,
        clearEnv: ["OPENAI_API_KEY"],
      },
      {
        env: {
          OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
          OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
        },
        modelProvider: "openai",
      },
    );

    expect(runtime).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "guardian_subagent",
      serviceTier: "flex",
      codeModeOnly: true,
      loopDetectionPreToolUseRelay: false,
    });
    expectFields(runtime.start, "runtime start", {
      transport: "websocket",
      url: localUrl,
      headers: { "X-Test": "yes" },
    });
    expect(runtime.start).not.toHaveProperty("clearEnv");
  });

  it("builds Codex permissions-profile config for app-server network proxy", () => {
    const runtime = resolveAppServer({
      sandbox: "workspace-write",
      networkProxy: {
        enabled: true,
        profileName: "mock-proxy",
        mode: "limited",
        domains: { " api.openai.com ": "allow", "blocked.example.com": "deny" },
        unixSockets: { " /tmp/mock-proxy.sock ": "allow", "/tmp/blocked.sock": "none" },
        proxyUrl: "http://127.0.0.1:3128",
        socksUrl: "socks5h://127.0.0.1:8081",
        enableSocks5: true,
        enableSocks5Udp: false,
        allowUpstreamProxy: true,
        allowLocalBinding: false,
      },
    });

    expect(runtime.networkProxy).toEqual({
      profileName: "mock-proxy",
      configFingerprint: expect.any(String),
      configPatch: {
        "features.network_proxy.enabled": true,
        default_permissions: "mock-proxy",
        permissions: {
          "mock-proxy": {
            filesystem: { ":minimal": "read", ":project_roots": { ".": "write" } },
            network: {
              enabled: true,
              mode: "limited",
              domains: { "api.openai.com": "allow", "blocked.example.com": "deny" },
              unix_sockets: { "/tmp/mock-proxy.sock": "allow", "/tmp/blocked.sock": "deny" },
              proxy_url: "http://127.0.0.1:3128",
              socks_url: "socks5h://127.0.0.1:8081",
              enable_socks5: true,
              enable_socks5_udp: false,
              allow_upstream_proxy: true,
              allow_local_binding: false,
            },
          },
        },
      },
    });
  });

  it("uses read-only filesystem rules for read-only network proxy profiles", () => {
    const runtime = resolveAppServer({
      sandbox: "read-only",
      networkProxy: { enabled: true, domains: { "example.com": "allow" } },
    });
    const profileName = runtime.networkProxy?.profileName;
    expect(profileName).toMatch(/^openclaw-network-[a-f0-9]{16}$/u);
    expect(runtime.networkProxy?.configPatch.default_permissions).toBe(profileName);
    expect(runtime.networkProxy?.configPatch.permissions).toMatchObject({
      [profileName ?? ""]: { filesystem: { ":project_roots": { ".": "read" } } },
    });
  });

  it("falls back for non-positive app-server timer config", () => {
    expect(resolveAppServer({ requestTimeoutMs: 0 }).requestTimeoutMs).toBe(60_000);
  });

  it("normalizes app-server environment variables to clear", () => {
    const runtime = resolveAppServer({ clearEnv: [" OPENAI_API_KEY ", "", "  "] });
    expect(runtime.start.clearEnv).toEqual(["OPENAI_API_KEY"]);
  });

  it("preserves future service tier values", () => {
    expect(resolveAppServer({ serviceTier: "batch-preview" }).serviceTier).toBe("batch-preview");
  });

  it("passes resolved app-server SecretInput strings through to auth token and headers", () => {
    const runtime = resolveAppServer({
      transport: "websocket",
      url: remoteUrl,
      authToken: " resolved-capability-token ",
      remoteWorkspaceRoot: " /srv/workspaces ",
      headers: {
        " x-codex-client-session-token ": " resolved-session-token ",
        Authorization: " Bearer explicit-token ",
      },
    });

    expectFields(runtime.start, "runtime start", {
      authToken: "resolved-capability-token",
      headers: {
        "x-codex-client-session-token": "resolved-session-token",
        Authorization: "Bearer explicit-token",
      },
    });
    expect(runtime).toMatchObject({
      connectionClass: "remote",
      remoteWorkspaceRoot: "/srv/workspaces",
    });
  });

  it("honors explicitly configured native workspace temporary-root exclusions", () => {
    const runtime = resolveAppServer({
      sandbox: "workspace-write",
      args: [
        "app-server",
        "--config",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
      ],
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    const expected = {
      type: "workspaceWrite",
      writableRoots: ["/qa/workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    const policyFor = (args: string[]) =>
      codexSandboxPolicyForTurn(runtime.sandbox, "/qa/workspace", args);
    expect(policyFor(runtime.start.args)).toEqual(expected);
    expect(
      policyFor([
        ...runtime.start.args,
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=false",
      ]),
    ).toEqual({ ...expected, excludeTmpdirEnvVar: false });
  });

  it("preserves an explicitly read-only sandbox for forced private-QA Codex runtime", () => {
    const runtime = resolveAppServer(
      { mode: "yolo", approvalPolicy: "never", sandbox: "read-only" },
      { env: { OPENCLAW_BUILD_PRIVATE_QA: "1", OPENCLAW_QA_FORCE_RUNTIME: "codex" } },
    );

    expectRuntimePolicy(runtime, { ...fullAccessPolicy, sandbox: "read-only" });
    expect(codexSandboxPolicyForTurn(runtime.sandbox, "/qa/workspace", runtime.start.args)).toEqual(
      { type: "readOnly", networkAccess: false },
    );
  });

  it("uses shared user-home defaults only for supervision control connections", () => {
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: { supervision: { enabled: true } },
      env: {},
      requirementsToml: null,
    });

    expect(runtime.start).toMatchObject({ transport: "stdio", homeScope: "user" });
    expect(runtime.start).not.toHaveProperty("url");
  });

  it("resolves opt-in user-home coexistence only for local stdio", () => {
    expect(resolveAppServer({ homeScope: "user" }).start.homeScope).toBe("user");
    expect(() =>
      resolveAppServer({
        transport: "websocket",
        url: localUrl,
        homeScope: "user",
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.homeScope=user requires appServer.transport=stdio or unix",
    );
  });

  it("checks shared user config before enabling model-backed approval review", async () => {
    await withTempDir("openclaw-codex-user-home-", async (codexHome) => {
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        'openai_base_url = "http://localhost:8080/v1"\n',
      );

      expect(canUseReviewer({ env: { CODEX_HOME: codexHome }, homeScope: "user" })).toBe(false);
    });
  });

  it("treats only explicit OpenAI model context as safe for Codex-backed auto-review", () => {
    expect(canUseReviewer()).toBe(true);
    expect(canUseReviewer({ modelProvider: "codex", model: "openai/gpt-5.5" })).toBe(true);
    expect(canUseCodexModelBackedApprovalsReviewerForModel({})).toBe(false);
    expect(canUseReviewer({ modelProvider: "codex" })).toBe(false);
    expect(canUseReviewer({ modelProvider: "openrouter", model: "openai/gpt-5.5" })).toBe(false);
    expect(canUseReviewer({ model: "lmstudio/local-model" })).toBe(false);
    for (const [context, expected, trusted] of [
      [
        { model: "lmstudio/local-model", bindingModel: "gpt-5.5", nativeAuthProfile: true },
        { modelProvider: "lmstudio", model: "lmstudio/local-model" },
        false,
      ],
      [
        {
          provider: "codex",
          model: "openai/gpt-5.5",
          bindingModel: "local-model",
          bindingModelProvider: "lmstudio",
        },
        { modelProvider: "openai", model: "openai/gpt-5.5" },
        true,
      ],
      [
        {
          provider: "codex",
          model: "openai/gpt-oss-20b",
          bindingModel: "openai/gpt-oss-20b",
          bindingModelProvider: "lmstudio",
        },
        { modelProvider: "lmstudio", model: "openai/gpt-oss-20b" },
        false,
      ],
    ] as const) {
      const resolved = resolveCodexModelBackedReviewerPolicyContext(context);
      expect(resolved).toEqual(expected);
      expect(canUseCodexModelBackedApprovalsReviewerForModel(resolved)).toBe(trusted);
    }
    for (const codexConfigToml of [
      'openai_base_url = """http://localhost:8080/v1"""',
      'chatgpt_base_url = "http://localhost:8080/backend-api"',
      '[model_providers.openai]\nbase_url = "http://localhost:8080/v1"',
    ]) {
      expect(canUseReviewer({ codexConfigToml })).toBe(false);
    }
    for (const codexConfigToml of [
      'openai_base_url = "https://api.openai.com/v1"',
      'chatgpt_base_url = "https://chatgpt.com/backend-api/"',
    ]) {
      expect(canUseReviewer({ codexConfigToml })).toBe(true);
    }
    for (const openai of [
      { baseUrl: "http://localhost:8080/v1", models: [] },
      {
        ...baseOpenai,
        request: { proxy: { mode: "explicit-proxy" as const, url: "http://localhost:8080" } },
      },
      { ...baseOpenai, headers: proxyHeaders },
      { ...baseOpenai, authHeader: false },
      {
        baseUrl: "https://api.openai.com/v1",
        models: [
          {
            id: "gpt-5.5",
            name: "GPT with custom headers",
            reasoning: true,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
            headers: proxyHeaders,
          },
        ],
      },
    ]) {
      expect(canUseReviewer({ config: { models: { providers: { openai } } } })).toBe(false);
    }
    expect(canUseReviewer({ env: { OPENAI_BASE_URL: "http://localhost:8080/v1" } })).toBe(false);
    expect(
      canUseReviewer({ env: { OPENAI_BASE_URL: "", OPENAI_API_BASE: "http://localhost:8080/v1" } }),
    ).toBe(false);
  });

  it("parses auto native Codex plugin destructive policy", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": marketplacePlugin("google-calendar"),
          slack: {
            ...marketplacePlugin("slack"),
            enabled: false,
            allow_destructive_actions: false,
          },
          gmail: { ...marketplacePlugin("gmail"), allow_destructive_actions: true },
        },
      },
    });

    expect(config.codexPlugins?.allow_destructive_actions).toBe("auto");
    expect(resolveCodexPluginsPolicy(config)).toEqual({
      configured: true,
      enabled: true,
      allowAllPlugins: false,
      allowDestructiveActions: true,
      destructiveApprovalMode: "auto",
      pluginPolicies: [
        pluginPolicy("gmail", true, "allow"),
        pluginPolicy("google-calendar", true, "auto"),
        pluginPolicy("slack", false, "deny"),
      ],
    });
  });

  it("rejects unsafe native plugin marketplace identity", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        plugins: { gmail: { marketplaceName: "../marketplace", pluginName: "gmail" } },
      },
    });
    expect(config.codexPlugins).toBeUndefined();
    expect(resolveCodexPluginsPolicy(config).pluginPolicies).toStrictEqual([]);
  });

  it("reads effective native Computer Use state before managed spawn", () => {
    const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
    const resolveForConfig = (codexConfigToml: string) =>
      resolveCodexAppServerStartOptionsForAgent({
        startOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml,
      }).managedCommandOrder;

    for (const [toml, expected] of [
      ['[plugins."computer-use@openai-bundled"]\nenabled = false\n', undefined],
      ['[plugins."computer-use@openai-bundled"]\n', "desktop-first"],
      [
        'model_context_window = 9223372036854775807\ndeveloper_instructions = """\n[plugins."computer-use@openai-bundled"]\nenabled = true\n"""\n',
        undefined,
      ],
      ["[plugins.invalid", "desktop-first"],
    ] as const) {
      expect(resolveForConfig(toml)).toBe(expected);
    }

    const customIdentityStartOptions = resolveRuntimeForTest({
      pluginConfig: { computerUse: { pluginName: "custom-computer-use" } },
    }).start;
    expect(customIdentityStartOptions.managedCommandOrder).toBe("desktop-first");
    expect(customIdentityStartOptions.managedComputerUsePluginNames).toEqual([
      "computer-use",
      "custom-computer-use",
    ]);
    const privateStartOptions = resolveAppServer(
      { homeScope: "user" },
      { managedCommandOrder: "package-first" },
    ).start;
    expect(
      resolveCodexAppServerStartOptionsForAgent({
        startOptions: privateStartOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml: '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      }).managedCommandOrder,
    ).toBe("package-first");
  });

  it("uses desktop-first when persisted Codex state cannot be read", async () => {
    await withTempDir("openclaw-codex-unreadable-home-", async (agentDir) => {
      const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
      await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
      await fs.mkdir(path.join(agentDir, "codex-home", "config.toml"));

      expect(
        resolveCodexAppServerStartOptionsForAgent({ startOptions, agentDir }).managedCommandOrder,
      ).toBe("desktop-first");
    });
  });

  it.each<[RuntimeParams, string]>([
    [plugin({ command: inlineCommand }), "plugins.entries.codex.config.appServer.command"],
    [{ env: { OPENCLAW_CODEX_APP_SERVER_BIN: inlineCommand } }, "OPENCLAW_CODEX_APP_SERVER_BIN"],
  ])("rejects inline arguments from %j", (params, field) => {
    expect(() => resolveRuntimeForTest(params)).toThrow(
      `${field} must be only the Codex app-server executable path`,
    );
  });

  it("resolves Computer Use setup from plugin config and environment fallbacks", () => {
    expect(
      resolveCodexComputerUseConfig({
        pluginConfig: {
          computerUse: { autoInstall: true, marketplaceName: "desktop-tools" },
        },
        env: { OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_NAME: "env-fallback-plugin" },
      }),
    ).toEqual({
      ...computerUseDefaults,
      autoInstall: true,
      pluginName: "env-fallback-plugin",
      mcpServerName: "computer-use",
      marketplaceName: "desktop-tools",
    });

    expectFields(
      resolveCodexComputerUseConfig({
        pluginConfig: {},
        env: {
          OPENCLAW_CODEX_COMPUTER_USE: "1",
          OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_SOURCE: "github:example/plugins",
          OPENCLAW_CODEX_COMPUTER_USE_AUTO_INSTALL: "true",
          OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS: "30000",
        },
      }),
      "computer use config",
      {
        ...computerUseDefaults,
        autoInstall: true,
        marketplaceDiscoveryTimeoutMs: 30_000,
        marketplaceSource: "github:example/plugins",
      },
    );

    for (const value of ["0x10", "1e3"]) {
      expectFields(
        resolveCodexComputerUseConfig({
          pluginConfig: {},
          env: {
            OPENCLAW_CODEX_COMPUTER_USE: "1",
            OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS: value,
          },
        }),
        "computer use config",
        computerUseDefaults,
      );
    }
  });

  it("blocks Codex app-server local execution for normalized allowlist exec mode", () => {
    expect(() => resolveRuntimeForTest({ execMode: "allowlist" })).toThrow(
      "Codex app-server local execution is unavailable because effective tools.exec.mode=allowlist",
    );
  });

  it("enforces canonical per-agent exec deny before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: { exec: { mode: "full" } },
        agents: { entries: { reviewer: { tools: { exec: { mode: "deny" } } } } },
      },
      agentId: "reviewer",
    });

    expect(execPolicy.mode).toBe("deny");
    expect(() => resolveRuntimeForTest({ execPolicy })).toThrow(
      "Codex app-server local execution is unavailable because effective tools.exec.mode=deny",
    );
  });

  it("applies host exec approval security floors before starting Codex app-server", () => {
    const execPolicy = resolveExecPolicy(
      { mode: "full" },
      {
        approvals: approvals({ security: "deny" }),
      },
    );

    expect(execPolicy.mode).toBe("deny");
    let error: unknown;
    try {
      resolveAppServer(
        { mode: "yolo", approvalPolicy: "never", sandbox: "danger-full-access" },
        { execPolicy },
      );
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      name: "AgentHarnessPreflightError",
      scope: "harness",
      message: expect.stringContaining(
        "inspect them with `openclaw approvals get --gateway` and update that same target with `openclaw approvals set --gateway --stdin`",
      ),
    });
    expect((error as Error).message).not.toContain("--node");
  });

  it("does not apply host exec approval floors to an explicit full session", () => {
    const execPolicy = resolveExecPolicy(
      { mode: "ask" },
      {
        permissionMode: "full",
        approvals: approvals({ ask: "always" }),
      },
    );

    expect(execPolicy).toMatchObject({ mode: "full", security: "full", ask: "off" });
  });

  it("applies agent-scoped exec approval security floors before starting Codex app-server", () => {
    const execPolicy = resolveExecPolicy(
      { mode: "full" },
      {
        agentId: "codex-agent",
        approvals: approvals({ security: "full" }, { "codex-agent": { security: "deny" } }),
      },
    );

    expect(execPolicy.mode).toBe("deny");
    expect(() =>
      resolveAppServer(
        { mode: "yolo", approvalPolicy: "never", sandbox: "danger-full-access" },
        { execPolicy },
      ),
    ).toThrow(
      "Codex app-server local execution is unavailable because effective tools.exec.mode=deny",
    );
  });

  it.each<{
    name: string;
    options: Parameters<typeof resolveExecPolicy>[1];
    sandbox: "read-only" | "workspace-write";
    policy: Parameters<typeof expectRuntimePolicy>[1];
  }>([
    {
      name: "host",
      options: {
        approvals: approvals({ ask: "always" }),
      },
      sandbox: "read-only",
      policy: { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" },
    },
    {
      name: "agent",
      options: {
        agentId: "codex-agent",
        approvals: approvals({ ask: "off" }, { "codex-agent": { ask: "always" } }),
      },
      sandbox: "workspace-write",
      policy: perCommandPolicy,
    },
  ])(
    "applies $name exec approval ask floors before starting Codex app-server",
    ({ options, sandbox, policy }) => {
      const execPolicy = resolveExecPolicy({ mode: "full" }, options);
      expect(execPolicy.mode).toBe("ask");
      expectRuntimePolicy(
        resolveAppServer(
          { mode: "yolo", approvalPolicy: "never", sandbox, approvalsReviewer: "auto_review" },
          { execPolicy },
        ),
        policy,
      );
    },
  );

  it("rejects the retired untrusted approval policy at runtime", () => {
    expect(() =>
      readCodexPluginConfig({
        appServer: { approvalPolicy: "untrusted" },
      }),
    ).toThrow(
      'plugins.entries.codex.config.appServer.approvalPolicy="untrusted" is retired; run "openclaw doctor --fix" to migrate it to "on-request".',
    );
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "untrusted" },
      }),
    ).toThrow(
      'Codex app-server approval policy "untrusted" is retired; run "openclaw doctor --fix" and use "on-request".',
    );
  });

  it.each([
    {
      name: "auth tokens",
      secrets: ["tok_first", "tok_second"] as const,
      options: (secret: string) => ({ authToken: secret }),
    },
    {
      name: "environment values",
      secrets: ["sk-first", "sk-second"] as const,
      options: (secret: string) => ({ env: { OPENAI_API_KEY: secret } }),
    },
    {
      name: "headers",
      secrets: ["header-first", "header-second"] as const,
      options: (secret: string) => ({
        headers: {
          Authorization: `Bearer ${secret}`,
          "x-codex-client-session-token": `session-${secret}`,
        },
      }),
    },
  ])("isolates shared clients by $name without exposing secrets", ({ secrets, options }) => {
    const keyFor = (secret: string) =>
      codexAppServerStartOptionsKey({
        ...clientStart,
        ...options(secret),
      });
    const [firstSecret, secondSecret] = secrets;
    const first = keyFor(firstSecret);
    const second = keyFor(secondSecret);
    expect(first).not.toEqual(second);
    expect(keyFor(firstSecret)).toEqual(first);
    expect(first).not.toContain(firstSecret);
    expect(second).not.toContain(secondSecret);
  });

  it.each(["authBindingFingerprint", "agentDir"] as const)(
    "isolates shared clients by %s",
    (field) => {
      const keyFor = (value: string) =>
        codexAppServerStartOptionsKey(
          { transport: "stdio", command: "codex", args: ["app-server"], headers: {} },
          {
            authProfileId: "openai:work",
            [field]: value,
          },
        );
      expect(keyFor("/tmp/identity-a")).not.toEqual(keyFor("/tmp/identity-b"));
    },
  );

  it("keeps secret-derived shared-client keys stable across module reloads", async () => {
    const startOptions = {
      ...clientStart,
      authToken: "tok_reload",
      env: { OPENAI_API_KEY: "sk-reload" },
    };
    const first = codexAppServerStartOptionsKey(startOptions);

    vi.resetModules();
    const reloaded = await import("./config-runtime.js");

    expect(reloaded.codexAppServerStartOptionsKey(startOptions)).toEqual(first);
    expect(first).not.toContain("tok_reload");
    expect(first).not.toContain("sk-reload");
  });
});
