import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-runtime.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  codexSandboxPolicyForTurn,
  isCodexSandboxExecServerEnabled,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexSupervisionAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexPluginsPolicy,
  shouldAutoApproveCodexAppServerApprovals,
  withMcpElicitationsApprovalPolicy,
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

describe("withMcpElicitationsApprovalPolicy", () => {
  it("returns every field required by Codex granular approval policy", () => {
    expect(withMcpElicitationsApprovalPolicy("never")).toEqual({
      granular: {
        mcp_elicitations: true,
        request_permissions: false,
        rules: false,
        sandbox_approval: false,
        skill_approval: false,
      },
    });
  });
});

function resolveAppServer(
  appServer: unknown,
  options: Omit<NonNullable<Parameters<typeof resolveRuntimeForTest>[0]>, "pluginConfig"> = {},
) {
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

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("Codex app-server config", () => {
  it.each<
    [
      string,
      NonNullable<Parameters<typeof resolveRuntimeForTest>[0]>,
      Parameters<typeof expectRuntimePolicy>[1],
    ]
  >([
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
  ])("%s", (_name, params, policy) => {
    expectRuntimePolicy(resolveRuntimeForTest(params), policy);
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
        url: "ws://127.0.0.1:39175",
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
      url: "ws://127.0.0.1:39175",
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

    const networkProxy = runtime.networkProxy;
    if (!networkProxy) {
      throw new Error("Expected network proxy runtime config");
    }
    expect(networkProxy).toEqual({
      profileName: "mock-proxy",
      configFingerprint: expect.any(String),
      configPatch: {
        "features.network_proxy.enabled": true,
        default_permissions: "mock-proxy",
        permissions: {
          "mock-proxy": {
            filesystem: {
              ":minimal": "read",
              ":project_roots": { ".": "write" },
            },
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
      networkProxy: {
        enabled: true,
        domains: { "example.com": "allow" },
      },
    });
    const profileName = runtime.networkProxy?.profileName;
    const permissions = runtime.networkProxy?.configPatch.permissions as Record<
      string,
      { filesystem: { ":project_roots": { ".": string } } }
    >;

    expect(profileName).toMatch(/^openclaw-network-[a-f0-9]{16}$/u);
    expect(runtime.networkProxy?.configPatch.default_permissions).toBe(profileName);
    expect(permissions[profileName ?? ""]?.filesystem[":project_roots"]["."]).toBe("read");
  });

  it("clamps oversized app-server timer config", () => {
    const runtime = resolveAppServer({
      requestTimeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(runtime).toMatchObject({ requestTimeoutMs: MAX_TIMER_TIMEOUT_MS });
  });

  it("falls back for non-positive app-server timer config", () => {
    const runtime = resolveAppServer({ requestTimeoutMs: 0 });

    expect(runtime).toMatchObject({ requestTimeoutMs: 60_000 });
  });

  it("normalizes app-server environment variables to clear", () => {
    const runtime = resolveAppServer({ clearEnv: [" OPENAI_API_KEY ", "", "  "] });
    expect(runtime.start.clearEnv).toEqual(["OPENAI_API_KEY"]);
  });

  it.each([
    { enableUltrafast: undefined, expected: true },
    { enableUltrafast: true, expected: true },
    { enableUltrafast: false, expected: false },
  ])("resolves the Ultrafast disable switch $enableUltrafast", ({ enableUltrafast, expected }) => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: { appServer: { serviceTier: "fast", enableUltrafast } },
      env: {},
    });
    expect(runtime.enableUltrafast).toBe(expected);
    expect(runtime.serviceTier).toBe("priority");
  });

  it("preserves future service tier values", () => {
    expect(resolveAppServer({ serviceTier: "batch-preview" }).serviceTier).toBe("batch-preview");
  });

  it("rejects additional session homes for websocket app servers", () => {
    const appServer = { transport: "websocket", url: "ws://127.0.0.1:39175" };
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: { appServer, sessionCatalog: { homes: ["/srv/codex-extra"] } },
        env: {},
      }),
    ).toThrow(
      "plugins.entries.codex.config.sessionCatalog.homes requires appServer.transport=stdio",
    );
  });

  it("requires a websocket url when websocket transport is configured", () => {
    expect(() => resolveAppServer({ transport: "websocket" }, { env: {} })).toThrow(
      "appServer.url is required",
    );
  });

  it("passes resolved app-server SecretInput strings through to auth token and headers", () => {
    const runtime = resolveAppServer({
      transport: "websocket",
      url: "wss://codex-app-server.example.internal/ws",
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
      remoteAppsSubstrate: "preconfigured",
      remoteWorkspaceRoot: "/srv/workspaces",
    });
  });

  it("rejects unresolved app-server auth token SecretRefs at runtime option resolution", () => {
    expect(() =>
      resolveAppServer({
        transport: "websocket",
        url: "wss://codex-app-server.example.internal/ws",
        authToken: envRef("CODEX_APP_SERVER_TOKEN"),
      }),
    ).toThrow(
      'plugins.entries.codex.config.appServer.authToken: unresolved SecretRef "env:default:CODEX_APP_SERVER_TOKEN"',
    );
  });

  it("rejects unresolved app-server header SecretRefs at runtime option resolution", () => {
    expect(() =>
      resolveAppServer({
        transport: "websocket",
        url: "wss://codex-app-server.example.internal/ws",
        authToken: "capability-token",
        headers: {
          "x-codex-client-session-token": envRef("CODEX_CLIENT_SESSION_TOKEN"),
        },
      }),
    ).toThrow(
      'plugins.entries.codex.config.appServer.headers.x-codex-client-session-token: unresolved SecretRef "env:default:CODEX_CLIENT_SESSION_TOKEN"',
    );
  });

  it("rejects remote websocket app-servers without identity-bearing auth", () => {
    expect(() =>
      resolveAppServer({
        transport: "websocket",
        url: "wss://codex-app-server.example.internal/ws",
      }),
    ).toThrow(
      "remote Codex app-server WebSocket URLs require appServer.authToken or an Authorization header",
    );
  });

  it("does not let private-QA environment flags override native sandbox policy", () => {
    const privateQaCodexEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
    };
    const runtime = resolveAppServer(
      {
        mode: "yolo",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
      { env: privateQaCodexEnv },
    );

    expectRuntimePolicy(runtime, fullAccessPolicy);
    expect(codexSandboxPolicyForTurn(runtime.sandbox, "/qa/workspace", runtime.start.args)).toEqual(
      { type: "dangerFullAccess" },
    );
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
    const privateQaCodexEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
    };
    const runtime = resolveAppServer(
      {
        mode: "yolo",
        approvalPolicy: "never",
        sandbox: "read-only",
      },
      { env: privateQaCodexEnv },
    );

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
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

  it("honors explicit app-server settings for supervision control connections", () => {
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: {
        supervision: { enabled: true },
        appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
      },
      env: {},
      requirementsToml: null,
    });

    expect(runtime.start).toMatchObject({
      transport: "websocket",
      homeScope: "agent",
      url: "ws://127.0.0.1:39175",
    });
  });

  it("rejects Unix app-server connections outside the shared user home", () => {
    expect(() => resolveAppServer({ transport: "unix", homeScope: "agent" })).toThrow(
      "plugins.entries.codex.config.appServer.transport=unix requires appServer.homeScope=user",
    );
  });

  it("rejects non-Unix URLs for Unix app-server connections", () => {
    expect(() =>
      resolveAppServer({
        transport: "unix",
        homeScope: "user",
        url: "ws://127.0.0.1:39175",
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.url must use unix:// when appServer.transport is unix",
    );
  });

  it("resolves opt-in user-home coexistence only for local stdio", () => {
    const runtime = resolveAppServer({ homeScope: "user" });

    expect(runtime.start.homeScope).toBe("user");
    expect(() =>
      resolveAppServer({
        transport: "websocket",
        url: "ws://127.0.0.1:39175",
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

      expect(
        canUseCodexModelBackedApprovalsReviewerForModel({
          modelProvider: "openai",
          model: "gpt-5.5",
          env: { CODEX_HOME: codexHome },
          homeScope: "user",
        }),
      ).toBe(false);
    });
  });

  it("treats only explicit OpenAI model context as safe for Codex-backed auto-review", () => {
    const canUseReviewer = (
      context: Parameters<typeof canUseCodexModelBackedApprovalsReviewerForModel>[0] = {},
    ) =>
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        ...context,
      });
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
        baseUrl: "https://api.openai.com/v1",
        request: { proxy: { mode: "explicit-proxy" as const, url: "http://localhost:8080" } },
        models: [],
      },
      {
        baseUrl: "https://api.openai.com/v1",
        headers: { "x-openclaw-reviewer-proxy": "local" },
        models: [],
      },
      { baseUrl: "https://api.openai.com/v1", authHeader: false, models: [] },
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
            headers: { "x-openclaw-reviewer-proxy": "local" },
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

  it.each([
    "https://api.openai.com/v1",
    "https://chatgpt.com/backend-api",
    "https://chatgpt.com/backend-api/codex",
  ])("keeps model-backed review for a configured native OpenAI route: %s", (baseUrl) => {
    const model = {
      id: "gpt-5.5",
      name: "GPT",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    for (const openai of [
      { baseUrl, models: [model] },
      { baseUrl: "https://api.openai.com/v1", models: [{ ...model, baseUrl }] },
    ]) {
      const config = { models: { providers: { openai } } };
      expect(
        canUseCodexModelBackedApprovalsReviewerForModel({
          modelProvider: "openai",
          model: "openai/gpt-5.5@openai:default",
          config,
          env: {},
          codexConfigToml: null,
        }),
      ).toBe(true);
      expectRuntimePolicy(
        resolveRuntimeForTest({
          execMode: "auto",
          modelProvider: "openai",
          model: "gpt-5.5",
          config,
          codexConfigToml: null,
        }),
        autoReviewPolicy,
      );
    }
  });

  it.each([
    "http://chatgpt.com/backend-api",
    "https://chatgpt.com.example.com/backend-api",
    "https://chatgpt.com@proxy.example.com/backend-api",
    "https://proxy.example.com/backend-api",
    "not a URL",
  ])("rejects configured non-native reviewer routes: %s", (baseUrl) => {
    const model = {
      id: "gpt-5.5",
      name: "GPT",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    for (const openai of [
      { baseUrl, models: [model] },
      { baseUrl: "https://chatgpt.com/backend-api/codex", models: [{ ...model, baseUrl }] },
    ]) {
      expect(
        canUseCodexModelBackedApprovalsReviewerForModel({
          modelProvider: "openai",
          model: "gpt-5.5",
          config: { models: { providers: { openai } } },
          env: {},
          codexConfigToml: null,
        }),
      ).toBe(false);
    }
  });

  it("does not let a trusted ChatGPT route bypass request or native endpoint overrides", () => {
    const baseUrl = "https://chatgpt.com/backend-api/codex";
    const config = { models: { providers: { openai: { baseUrl, models: [] } } } };
    const context = {
      modelProvider: "openai",
      model: "gpt-5.5",
      config,
      env: {},
      codexConfigToml: null,
    };
    for (const override of [
      { headers: { "x-reviewer-proxy": "custom" } },
      { request: { proxy: { mode: "explicit-proxy" as const, url: "http://localhost:8080" } } },
      { authHeader: false },
      { localService: {} },
    ]) {
      expect(
        canUseCodexModelBackedApprovalsReviewerForModel({
          ...context,
          config: { models: { providers: { openai: { baseUrl, models: [], ...override } } } },
        }),
      ).toBe(false);
    }
    for (const override of [
      { env: { OPENAI_BASE_URL: baseUrl } },
      { env: { OPENAI_API_BASE: "http://localhost:8080/v1" } },
      { codexConfigToml: `openai_base_url = "${baseUrl}"` },
      { codexArgs: ["-c", `model_providers.openai.base_url="${baseUrl}"`] },
      { codexConfigToml: 'chatgpt_base_url = "https://proxy.example.com/backend-api"' },
    ]) {
      expect(canUseCodexModelBackedApprovalsReviewerForModel({ ...context, ...override })).toBe(
        false,
      );
    }
  });

  it("forces prompting when explicit no-prompt config cannot use model-backed review", () => {
    const runtime = resolveAppServer(
      {
        mode: "guardian",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "auto_review",
      },
      { modelProvider: "lmstudio", model: "local-model" },
    );

    expectRuntimePolicy(runtime, userReviewPolicy);
    expect(shouldAutoApproveCodexAppServerApprovals(runtime)).toBe(false);
  });

  it("enables sandbox execution for remote placement", () => {
    expect(
      isCodexSandboxExecServerEnabled(undefined, { placementExecutionMode: "remote-exec" }),
    ).toBe(true);
  });

  it("parses auto native Codex plugin destructive policy", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": { marketplaceName: "openai-curated", pluginName: "google-calendar" },
          slack: {
            marketplaceName: "openai-curated",
            pluginName: "slack",
            enabled: false,
            allow_destructive_actions: false,
          },
          gmail: {
            marketplaceName: "openai-curated",
            pluginName: "gmail",
            allow_destructive_actions: true,
          },
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
        {
          configKey: "gmail",
          marketplaceName: "openai-curated",
          pluginName: "gmail",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "allow",
        },
        {
          configKey: "google-calendar",
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "auto",
        },
        {
          configKey: "slack",
          marketplaceName: "openai-curated",
          pluginName: "slack",
          enabled: false,
          allowDestructiveActions: false,
          destructiveApprovalMode: "deny",
        },
      ],
    });
  });

  it.each(["../marketplace"])(
    "rejects unsafe native plugin marketplace identity %j",
    (marketplaceName) => {
      const config = readCodexPluginConfig({
        codexPlugins: {
          enabled: true,
          plugins: {
            gmail: { marketplaceName, pluginName: "gmail" },
          },
        },
      });

      expect(config.codexPlugins).toBeUndefined();
      expect(resolveCodexPluginsPolicy(config).pluginPolicies).toStrictEqual([]);
    },
  );

  it("treats configured and environment commands as explicit overrides", () => {
    expectFields(
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: { command: "C:\\Program Files\\OpenAI Codex\\codex.exe" },
          computerUse: { enabled: true },
        },
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
      "configured start",
      {
        command: "C:\\Program Files\\OpenAI Codex\\codex.exe",
        managedCommandOrder: undefined,
        commandSource: "config",
      },
    );

    expect(
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
    ).toMatchObject({ command: "/usr/local/bin/codex", commandSource: "env" });
  });

  it("reads effective native Computer Use state before managed spawn", () => {
    const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
    const resolveForConfig = (codexConfigToml: string) =>
      resolveCodexAppServerStartOptionsForAgent({
        startOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml,
      }).managedCommandOrder;

    expect(
      resolveForConfig('[plugins."computer-use@openai-bundled"]\nenabled = false\n'),
    ).toBeUndefined();
    expect(resolveForConfig('[plugins."computer-use@openai-bundled"]\n')).toBe("desktop-first");
    expect(
      resolveForConfig(
        'model_context_window = 9223372036854775807\ndeveloper_instructions = """\n[plugins."computer-use@openai-bundled"]\nenabled = true\n"""\n',
      ),
    ).toBeUndefined();
    expect(resolveForConfig("[plugins.invalid")).toBe("desktop-first");

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

  it("keeps desktop ownership for Computer Use persisted in an agent Codex home", async () => {
    await withTempDir("openclaw-codex-agent-home-", async (agentDir) => {
      const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
      const codexHome = path.join(agentDir, "codex-home");
      await fs.mkdir(codexHome);
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );

      expect(
        resolveCodexAppServerStartOptionsForAgent({ startOptions, agentDir }).managedCommandOrder,
      ).toBe("desktop-first");
    });
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

  it("rejects Codex app-server command overrides that include inline arguments", () => {
    expect(() =>
      resolveAppServer({
        command: "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.command must be only the Codex app-server executable path",
    );
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        env: {
          OPENCLAW_CODEX_APP_SERVER_BIN:
            "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        },
      }),
    ).toThrow("OPENCLAW_CODEX_APP_SERVER_BIN must be only the Codex app-server executable path");
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

  it("resolves Computer Use operational policy knobs", () => {
    expect(
      resolveCodexComputerUseConfig({
        pluginConfig: {
          computerUse: {
            enabled: true,
            liveTestTimeoutMs: 45_000,
            toolCallTimeoutMs: 55_000,
            healthCheckEnabled: true,
            healthCheckIntervalMinutes: 120,
            pluginCacheMode: "independent",
            strictReadiness: true,
            autoRepair: true,
          },
        },
        env: {
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_ENABLED: "false",
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES: "240",
          OPENCLAW_CODEX_COMPUTER_USE_STRICT_READINESS: "false",
          OPENCLAW_CODEX_COMPUTER_USE_AUTO_REPAIR: "false",
        },
      }),
    ).toMatchObject({
      enabled: true,
      liveTestTimeoutMs: 45_000,
      toolCallTimeoutMs: 55_000,
      healthCheckEnabled: true,
      healthCheckIntervalMinutes: 120,
      pluginCacheMode: "independent",
      strictReadiness: true,
      autoRepair: true,
    });

    expect(
      resolveCodexComputerUseConfig({
        pluginConfig: { computerUse: { enabled: true } },
        env: {
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_ENABLED: "1",
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES: "90",
          OPENCLAW_CODEX_COMPUTER_USE_STRICT_READINESS: "true",
          OPENCLAW_CODEX_COMPUTER_USE_AUTO_REPAIR: "true",
          OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_CACHE_MODE: "stale-copy",
        },
      }),
    ).toMatchObject({
      healthCheckEnabled: true,
      healthCheckIntervalMinutes: 60,
      pluginCacheMode: "independent",
      strictReadiness: true,
      autoRepair: true,
    });
  });

  it("preserves explicit read-only app-server sandbox for auto mode", () => {
    const configRuntime = resolveAppServer(
      {
        mode: "yolo",
        approvalPolicy: "never",
        sandbox: "read-only",
        approvalsReviewer: "user",
      },
      { execMode: "auto", modelProvider: "openai", env: {} },
    );
    expectRuntimePolicy(configRuntime, readOnlyAutoReviewPolicy);
  });

  it.each(["deny", "allowlist"] as const)(
    "blocks Codex app-server local execution for normalized OpenClaw %s exec mode",
    (execMode) => {
      expect(() => resolveRuntimeForTest({ pluginConfig: {}, execMode })).toThrow(
        `Codex app-server local execution is unavailable because effective tools.exec.mode=${execMode}`,
      );
    },
  );

  it("preserves explicit read-only app-server sandbox for ask mode", () => {
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
      env: {
        OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expectRuntimePolicy(envRuntime, readOnlyUserReviewPolicy);
  });

  it("fails closed when Guardian local-model fallback needs user approvals but requirements disallow them", () => {
    expect(() =>
      resolveAppServer(
        { mode: "guardian" },
        {
          modelProvider: "lmstudio",
          model: "local-model",
          requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
        },
      ),
    ).toThrow("tools.exec.mode=ask requires Codex app-server user approvals");
  });

  it("fails closed when ask mode can only use never approvals", () => {
    expect(() =>
      resolveRuntimeForTest({
        execMode: "ask",
        requirementsToml: 'allowed_approval_policies = ["never"]',
      }),
    ).toThrow("tools.exec.mode=ask requires Codex app-server prompting approvals");
  });

  it("honors managed prompting approvals for auto mode", () => {
    expectRuntimePolicy(
      resolveRuntimeForTest({
        execMode: "auto",
        modelProvider: "openai",
        requirementsToml: 'allowed_approval_policies = ["untrusted", "never"]',
      }),
      { ...autoReviewPolicy, approvalPolicy: "untrusted" },
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

  it("keeps legacy full exec security with ask=on-miss on default Codex yolo", () => {
    const execPolicy = resolveExecPolicy({ security: "full", ask: "on-miss" });

    expectRuntimePolicy(resolveRuntimeForTest({ execPolicy }), fullAccessPolicy);
  });

  it("fails closed when legacy full exec with ask cannot use full Codex sandbox", () => {
    expect(() =>
      resolveRuntimeForTest({
        execPolicy: resolveExecPolicy({ security: "full", ask: "always" }),
        requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
      }),
    ).toThrow("legacy full exec security with ask requires Codex app-server danger-full-access");
  });

  it("fails closed when managed policy forbids mandatory per-command approvals", () => {
    expect(() =>
      resolveRuntimeForTest({
        execPolicy: resolveExecPolicy({ security: "full", ask: "always" }),
        requirementsToml: 'allowed_approval_policies = ["on-request", "never"]',
      }),
    ).toThrow("tools.exec.ask=always requires Codex app-server per-command approvals");
  });

  it("honors managed policy that permits mandatory per-command approvals", () => {
    expectRuntimePolicy(
      resolveRuntimeForTest({
        execPolicy: resolveExecPolicy({ security: "full", ask: "always" }),
        requirementsToml: 'allowed_approval_policies = ["on-request", "untrusted"]',
      }),
      perCommandPolicy,
    );
  });

  it("clamps legacy full exec with ask when an OpenClaw sandbox is active", () => {
    expectRuntimePolicy(
      resolveRuntimeForTest({
        execPolicy: resolveExecPolicy({ security: "full", ask: "always" }),
        openClawSandboxActive: true,
        requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
      }),
      {
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      },
    );
  });

  it("applies host exec approval security floors before starting Codex app-server", () => {
    const execPolicy = resolveExecPolicy(
      { mode: "full" },
      {
        approvals: {
          version: 1,
          defaults: { security: "deny" },
          agents: {},
        },
      },
    );

    expect(execPolicy.mode).toBe("deny");
    let error: unknown;
    try {
      resolveAppServer(
        {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
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
        approvals: {
          version: 1,
          defaults: { ask: "always" },
          agents: {},
        },
      },
    );

    expect(execPolicy).toMatchObject({ mode: "full", security: "full", ask: "off" });
  });

  it("preserves explicit read-only sandbox for host exec approval ask floors", () => {
    const execPolicy = resolveExecPolicy(
      { mode: "full" },
      {
        approvals: {
          version: 1,
          defaults: { ask: "always" },
          agents: {},
        },
      },
    );

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveAppServer(
        {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "read-only",
          approvalsReviewer: "auto_review",
        },
        { execPolicy },
      ),
      {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      },
    );
  });

  it("applies agent-scoped exec approval security floors before starting Codex app-server", () => {
    const execPolicy = resolveExecPolicy(
      { mode: "full" },
      {
        agentId: "codex-agent",
        approvals: {
          version: 1,
          defaults: { security: "full" },
          agents: {
            "codex-agent": { security: "deny" },
          },
        },
      },
    );

    expect(execPolicy.mode).toBe("deny");
    expect(() =>
      resolveAppServer(
        {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
        { execPolicy },
      ),
    ).toThrow(
      "Codex app-server local execution is unavailable because effective tools.exec.mode=deny",
    );
  });

  it("applies agent-scoped exec approval ask floors before starting Codex app-server", () => {
    const execPolicy = resolveExecPolicy(
      { mode: "full" },
      {
        agentId: "codex-agent",
        approvals: {
          version: 1,
          defaults: { ask: "off" },
          agents: {
            "codex-agent": { ask: "always" },
          },
        },
      },
    );

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveAppServer(
        {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "workspace-write",
          approvalsReviewer: "auto_review",
        },
        { execPolicy },
      ),
      perCommandPolicy,
    );
  });

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
        transport: "websocket",
        command: "codex",
        args: [],
        headers: {},
        url: "ws://127.0.0.1:39175",
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
      const options = {
        transport: "stdio" as const,
        command: "codex",
        args: ["app-server"],
        headers: {},
      };
      const keyFor = (value: string) =>
        codexAppServerStartOptionsKey(options, {
          authProfileId: "openai:work",
          [field]: value,
        });
      expect(keyFor("/tmp/identity-a")).not.toEqual(keyFor("/tmp/identity-b"));
    },
  );

  it("keeps secret-derived shared-client keys stable across module reloads", async () => {
    const startOptions = {
      transport: "websocket" as const,
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_reload",
      headers: {},
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
