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
  resolveCodexAppServerUserHomeDir,
  resolveCodexSupervisionAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexPluginsPolicy,
  shouldAutoApproveCodexAppServerApprovals,
  withMcpElicitationsApprovalPolicy,
} from "./config.js";
import { expectFields, expectRuntimePolicy, resolveRuntimeForTest } from "./config.test-support.js";

const retiredTurnIdleTimeoutKeys = [
  "turnCompletionIdleTimeoutMs",
  "turnAssistantCompletionIdleTimeoutMs",
  "postToolRawAssistantCompletionIdleTimeoutMs",
];

const fullAccessPolicy = {
  approvalPolicy: "never",
  sandbox: "danger-full-access",
  approvalsReviewer: "user",
};
const autoReviewPolicy = {
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  approvalsReviewer: "auto_review",
};
const userReviewPolicy = {
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  approvalsReviewer: "user",
};
const readOnlyAutoReviewPolicy = {
  approvalPolicy: "on-request",
  sandbox: "read-only",
  approvalsReviewer: "auto_review",
};
const readOnlyUserReviewPolicy = {
  approvalPolicy: "on-request",
  sandbox: "read-only",
  approvalsReviewer: "user",
};
const perCommandPolicy = {
  approvalPolicy: "untrusted",
  sandbox: "danger-full-access",
  approvalsReviewer: "user",
};

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

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("Codex app-server config", () => {
  it("only auto-approves app-server approvals for full yolo runtime policy", () => {
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "never",
        sandbox: "workspace-write",
      }),
    ).toBe(false);
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      }),
    ).toBe(false);
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
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
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
          headers: { "X-Test": "yes" },
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
          approvalsReviewer: "guardian_subagent",
          serviceTier: "flex",
          codeModeOnly: true,
          loopDetectionPreToolUseRelay: false,
        },
      },
      env: {
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
      modelProvider: "openai",
    });

    expectFields(runtime, "runtime", {
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
  });

  it("keeps the Codex loop-detection PreToolUse relay enabled by default", () => {
    expect(resolveRuntimeForTest().loopDetectionPreToolUseRelay).toBe(true);
  });

  it("builds Codex permissions-profile config for app-server network proxy", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          sandbox: "workspace-write",
          networkProxy: {
            enabled: true,
            profileName: "mock-proxy",
            mode: "limited",
            domains: {
              " api.openai.com ": "allow",
              "blocked.example.com": "deny",
            },
            unixSockets: {
              " /tmp/mock-proxy.sock ": "allow",
              "/tmp/blocked.sock": "none",
            },
            proxyUrl: "http://127.0.0.1:3128",
            socksUrl: "socks5h://127.0.0.1:8081",
            enableSocks5: true,
            enableSocks5Udp: false,
            allowUpstreamProxy: true,
            allowLocalBinding: false,
          },
        },
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
              ":project_roots": {
                ".": "write",
              },
            },
            network: {
              enabled: true,
              mode: "limited",
              domains: {
                "api.openai.com": "allow",
                "blocked.example.com": "deny",
              },
              unix_sockets: {
                "/tmp/mock-proxy.sock": "allow",
                "/tmp/blocked.sock": "deny",
              },
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
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          sandbox: "read-only",
          networkProxy: {
            enabled: true,
            domains: { "example.com": "allow" },
          },
        },
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
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          requestTimeoutMs: Number.MAX_SAFE_INTEGER,
        },
      },
    });

    expectFields(runtime, "runtime", {
      requestTimeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });

  it("falls back for non-positive app-server timer config", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          requestTimeoutMs: 0,
        },
      },
    });

    expectFields(runtime, "runtime", {
      requestTimeoutMs: 60_000,
    });
  });

  it("ignores app-server environment clearing for websocket transports", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
          clearEnv: ["OPENAI_API_KEY"],
        },
      },
      env: {},
    });

    expect(runtime.start).not.toHaveProperty("clearEnv");
  });

  it("normalizes app-server environment variables to clear", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          clearEnv: [" OPENAI_API_KEY ", "", "  "],
        },
      },
      env: {},
    });

    expectFields(runtime.start, "runtime start", {
      clearEnv: ["OPENAI_API_KEY"],
    });
  });

  it("normalizes legacy service tiers without discarding the rest of the config", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceTier: "fast",
        },
      },
      env: {},
      modelProvider: "openai",
    });

    expectFields(runtime, "runtime", {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
      serviceTier: "priority",
    });
  });

  it("passes through non-empty Codex app-server service tiers for forward compatibility", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: {
          serviceTier: "batch-preview",
        },
      },
      env: {},
    });

    expect(runtime.serviceTier).toBe("batch-preview");
  });

  it("rejects malformed plugin config instead of treating freeform strings as control values", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          approvalPolicy: "always",
        },
      }),
    ).toStrictEqual({});
  });

  it("parses named native session discovery homes and rejects empty labels", () => {
    expect(
      readCodexPluginConfig({
        sessionCatalog: {
          enabled: false,
          homes: [
            " /srv/codex-string ",
            { path: " /srv/codex-named ", label: " Named store " },
            { path: " /srv/codex-default " },
          ],
        },
      }).sessionCatalog,
    ).toEqual({
      enabled: false,
      homes: [
        "/srv/codex-string",
        { path: "/srv/codex-named", label: "Named store" },
        { path: "/srv/codex-default" },
      ],
    });
    expect(
      readCodexPluginConfig({ sessionCatalog: { homes: [{ path: "/srv/codex", label: " " }] } }),
    ).toStrictEqual({});
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

  it("rejects unknown app-server fields", () => {
    expect(
      readCodexPluginConfig({
        appServer: { requestTimeoutMs: 120_000, unknownTimeoutMs: 1 },
      }),
    ).toStrictEqual({});
  });

  it("rejects removed app-server topology fields", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          transport: "websocket",
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "capability-token",
          connectionClass: "remote",
          remoteAppsSubstrate: "preconfigured",
          remoteWorkspace: {
            localRoot: "/Users/kevinlin/code/openclaw",
            remoteRoot: "/home/oai/openclaw-workspaces",
          },
        },
      }),
    ).toStrictEqual({});
    expect(
      readCodexPluginConfig({
        appServer: {
          remoteWorkspace: {
            localRoot: "/Users/kevinlin/code/openclaw",
            remoteRoot: "/home/oai/openclaw-workspaces",
          },
        },
      }),
    ).toStrictEqual({});
  });

  it("requires a websocket url when websocket transport is configured", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: { appServer: { transport: "websocket" } },
        env: {},
      }),
    ).toThrow("appServer.url is required");
  });

  it("marks authenticated non-loopback websocket app-servers as remote runtimes", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "capability-token",
          remoteWorkspaceRoot: " /home/oai/openclaw-workspaces ",
        },
      },
    });

    expectFields(runtime, "runtime", {
      connectionClass: "remote",
      remoteAppsSubstrate: "preconfigured",
      remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
    });
  });

  it("passes resolved app-server SecretInput strings through to auth token and headers", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "wss://codex-app-server.example.internal/ws",
          authToken: " resolved-capability-token ",
          headers: {
            " x-codex-client-session-token ": " resolved-session-token ",
            Authorization: " Bearer explicit-token ",
          },
        },
      },
    });

    expectFields(runtime.start, "runtime start", {
      authToken: "resolved-capability-token",
      headers: {
        "x-codex-client-session-token": "resolved-session-token",
        Authorization: "Bearer explicit-token",
      },
    });
  });

  it("rejects unresolved app-server auth token SecretRefs at runtime option resolution", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "wss://codex-app-server.example.internal/ws",
            authToken: envRef("CODEX_APP_SERVER_TOKEN"),
          },
        },
      }),
    ).toThrow(
      'plugins.entries.codex.config.appServer.authToken: unresolved SecretRef "env:default:CODEX_APP_SERVER_TOKEN"',
    );
  });

  it("rejects unresolved app-server header SecretRefs at runtime option resolution", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "wss://codex-app-server.example.internal/ws",
            authToken: "capability-token",
            headers: {
              "x-codex-client-session-token": envRef("CODEX_CLIENT_SESSION_TOKEN"),
            },
          },
        },
      }),
    ).toThrow(
      'plugins.entries.codex.config.appServer.headers.x-codex-client-session-token: unresolved SecretRef "env:default:CODEX_CLIENT_SESSION_TOKEN"',
    );
  });

  it.each([
    ["ws://localhost:4242", "local-loopback"],
    ["ws://127.0.0.2:4242", "local-loopback"],
    ["ws://[::1]:4242", "local-loopback"],
    ["ws://[::ffff:127.0.0.2]:4242", "local-loopback"],
    ["wss://127.0.0.1.evil.com:4242", "remote"],
  ] as const)("classifies app-server URL %s as %s", (url, connectionClass) => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url,
          ...(connectionClass === "remote" ? { authToken: "capability-token" } : {}),
        },
      },
    });

    expectFields(runtime, "runtime", { connectionClass });
  });

  it("rejects remote websocket app-servers without identity-bearing auth", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "wss://codex-app-server.example.internal/ws",
          },
        },
      }),
    ).toThrow(
      "remote Codex app-server WebSocket URLs require appServer.authToken or an Authorization header",
    );
  });

  it("defaults native Codex approvals to unchained local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
    });

    expectRuntimePolicy(runtime, fullAccessPolicy);
    expect(runtime.codeModeOnly).toBe(false);
    expectFields(runtime.start, "runtime start", {
      command: "codex",
      commandSource: "managed",
      homeScope: "agent",
    });
  });

  it("does not let private-QA environment flags override native sandbox policy", () => {
    const privateQaCodexEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
    };
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
      env: privateQaCodexEnv,
    });

    expectRuntimePolicy(runtime, fullAccessPolicy);
    expect(codexSandboxPolicyForTurn(runtime.sandbox, "/qa/workspace", runtime.start.args)).toEqual(
      {
        type: "dangerFullAccess",
      },
    );
  });

  it("honors explicitly configured native workspace temporary-root exclusions", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          sandbox: "workspace-write",
          args: [
            "app-server",
            "-c",
            "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "-c",
            "sandbox_workspace_write.exclude_slash_tmp=true",
          ],
        },
      },
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    expect(codexSandboxPolicyForTurn(runtime.sandbox, "/qa/workspace", runtime.start.args)).toEqual(
      {
        type: "workspaceWrite",
        writableRoots: ["/qa/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    );
  });

  it("preserves an explicitly read-only sandbox for forced private-QA Codex runtime", () => {
    const privateQaCodexEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
    };
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "read-only",
        },
      },
      env: privateQaCodexEnv,
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    expect(codexSandboxPolicyForTurn(runtime.sandbox, "/qa/workspace", runtime.start.args)).toEqual(
      {
        type: "readOnly",
        networkAccess: false,
      },
    );
  });

  it("preserves production yolo filesystem policy for forced private-QA Codex runtime", () => {
    const env = { OPENCLAW_BUILD_PRIVATE_QA: "1", OPENCLAW_QA_FORCE_RUNTIME: "codex" };
    const runtime = resolveRuntimeForTest({ pluginConfig: {}, env });

    expectRuntimePolicy(runtime, fullAccessPolicy);
    expect(
      codexSandboxPolicyForTurn("workspace-write", "/qa/workspace", runtime.start.args),
    ).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/qa/workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it.each([
    {
      label: "long config arguments",
      args: [
        "--config",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config",
        "sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    {
      label: "inline config arguments",
      args: [
        "--config=sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    {
      label: "the last native config override",
      args: [
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=false",
        "-c",
        "sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
    },
  ])(
    "preserves native workspace root policy from $label",
    ({ args, excludeTmpdirEnvVar, excludeSlashTmp }) => {
      expect(codexSandboxPolicyForTurn("workspace-write", "/qa/workspace", args)).toEqual({
        type: "workspaceWrite",
        writableRoots: ["/qa/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar,
        excludeSlashTmp,
      });
    },
  );

  it("does not change ordinary harness connection defaults when supervision is enabled", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: { supervision: { enabled: true } },
    });

    expectFields(runtime.start, "runtime start", {
      transport: "stdio",
      homeScope: "agent",
    });
    expect(runtime.start).not.toHaveProperty("url");
  });

  it("uses shared user-home defaults only for supervision control connections", () => {
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: { supervision: { enabled: true } },
      env: {},
      requirementsToml: null,
    });

    expectFields(runtime.start, "runtime start", {
      transport: "stdio",
      homeScope: "user",
    });
    expect(runtime.start).not.toHaveProperty("url");
  });

  it("honors explicit app-server settings for supervision control connections", () => {
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: {
        supervision: { enabled: true },
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
        },
      },
      env: {},
      requirementsToml: null,
    });

    expectFields(runtime.start, "runtime start", {
      transport: "websocket",
      homeScope: "agent",
      url: "ws://127.0.0.1:39175",
    });
  });

  it("rejects Unix app-server connections outside the shared user home", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "unix",
            homeScope: "agent",
          },
        },
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.transport=unix requires appServer.homeScope=user",
    );
  });

  it("rejects non-Unix URLs for Unix app-server connections", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "unix",
            homeScope: "user",
            url: "ws://127.0.0.1:39175",
          },
        },
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.url must use unix:// when appServer.transport is unix",
    );
  });

  it("resolves opt-in user-home coexistence only for local stdio", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: { appServer: { homeScope: "user" } },
    });

    expect(runtime.start.homeScope).toBe("user");
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "ws://127.0.0.1:39175",
            homeScope: "user",
          },
        },
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.homeScope=user requires appServer.transport=stdio or unix",
    );
  });

  it("resolves the native user Codex home from CODEX_HOME or the OS home", () => {
    expect(resolveCodexAppServerUserHomeDir({ CODEX_HOME: "/tmp/custom-codex" })).toBe(
      "/tmp/custom-codex",
    );
    expect(resolveCodexAppServerUserHomeDir({}, () => "/Users/tester")).toBe(
      "/Users/tester/.codex",
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
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "codex",
        model: "openai/gpt-5.5",
      }),
    ).toBe(true);
    expect(canUseCodexModelBackedApprovalsReviewerForModel({})).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "codex",
        model: "gpt-5.5",
      }),
    ).toBe(false);
    for (const codexConfigToml of [
      'openai_base_url = """http://localhost:8080/v1"""\n',
      "openai_base_url = '''http://localhost:8080/v1'''\n",
      'chatgpt_base_url = """http://localhost:8080/backend-api"""\n',
      "[model_providers.openai]\nbase_url = '''http://localhost:8080/v1'''\n",
    ]) {
      expect(canUseReviewer({ codexConfigToml })).toBe(false);
    }
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openrouter",
        model: "openai/gpt-5.5",
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "lmstudio/local-model",
      }),
    ).toBe(false);
    const switchedLocalModel = resolveCodexModelBackedReviewerPolicyContext({
      model: "lmstudio/local-model",
      bindingModel: "gpt-5.5",
      nativeAuthProfile: true,
    });
    expect(switchedLocalModel).toEqual({
      modelProvider: "lmstudio",
      model: "lmstudio/local-model",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(switchedLocalModel)).toBe(false);
    const switchedOpenAIModel = resolveCodexModelBackedReviewerPolicyContext({
      provider: "codex",
      model: "openai/gpt-5.5",
      bindingModel: "local-model",
      bindingModelProvider: "lmstudio",
    });
    expect(switchedOpenAIModel).toEqual({
      modelProvider: "openai",
      model: "openai/gpt-5.5",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(switchedOpenAIModel)).toBe(true);
    const legacyBindingOpenAIModel = resolveCodexModelBackedReviewerPolicyContext({
      provider: "codex",
      model: "openai/gpt-5.5",
      bindingModelProvider: "lmstudio",
    });
    expect(legacyBindingOpenAIModel).toEqual({
      modelProvider: "openai",
      model: "openai/gpt-5.5",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(legacyBindingOpenAIModel)).toBe(true);
    const boundLocalOpenAIName = resolveCodexModelBackedReviewerPolicyContext({
      provider: "codex",
      model: "openai/gpt-oss-20b",
      bindingModel: "openai/gpt-oss-20b",
      bindingModelProvider: "lmstudio",
    });
    expect(boundLocalOpenAIName).toEqual({
      modelProvider: "lmstudio",
      model: "openai/gpt-oss-20b",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(boundLocalOpenAIName)).toBe(false);
    expect(
      canUseReviewer({ codexConfigToml: 'openai_base_url = "https://api.openai.com/v1"\n' }),
    ).toBe(true);
    expect(
      canUseReviewer({ codexConfigToml: 'openai_base_url = "http://localhost:8080/v1"\n' }),
    ).toBe(false);
    expect(
      canUseReviewer({
        codexConfigToml: '[model_providers.openai]\nbase_url = "http://localhost:8080/v1"\n',
      }),
    ).toBe(false);
    expect(
      canUseReviewer({
        codexConfigToml: 'model_providers.openai.base_url = "http://localhost:8080/v1"\n',
      }),
    ).toBe(false);
    expect(
      canUseReviewer({
        codexConfigToml:
          'model_providers = { openai = { base_url = "http://localhost:8080/v1" } }\n',
      }),
    ).toBe(false);
    expect(
      canUseReviewer({
        codexConfigToml: 'chatgpt_base_url = "https://chatgpt.com/backend-api/"\n',
      }),
    ).toBe(true);
    expect(
      canUseReviewer({
        codexConfigToml: 'chatgpt_base_url = "http://localhost:8080/backend-api"\n',
      }),
    ).toBe(false);
    expect(
      canUseReviewer({
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://localhost:8080/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
    for (const openAIProvider of [
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
      {
        baseUrl: "https://api.openai.com/v1",
        authHeader: false,
        models: [],
      },
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
      expect(
        canUseReviewer({
          config: {
            models: {
              providers: {
                openai: openAIProvider,
              },
            },
          },
        }),
      ).toBe(false);
    }
    expect(
      canUseReviewer({
        env: {
          OPENAI_BASE_URL: "http://localhost:8080/v1",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
    expect(
      canUseReviewer({
        env: {
          OPENAI_BASE_URL: "",
          OPENAI_API_BASE: "http://localhost:8080/v1",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("uses user approvals when Codex native OpenAI config is local", () => {
    const runtime = resolveRuntimeForTest({
      execMode: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
      codexConfigToml: 'openai_base_url = "http://localhost:8080/v1"\n',
    });

    expectRuntimePolicy(runtime, userReviewPolicy);
  });

  it.each([
    'openai_base_url = """https://api.openai.com/v1"""\n',
    "chatgpt_base_url = '''https://chatgpt.com/backend-api/'''\n",
    '[model_providers.openai]\nbase_url = """https://api.openai.com/v1"""\n',
    String.raw`openai_base_url = "https://api.\u006fpenai.com/v1"`,
  ])("keeps automatic review for native TOML endpoint syntax: %s", (codexConfigToml) => {
    const runtime = resolveRuntimeForTest({
      execMode: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
      codexConfigToml,
    });

    expect(runtime.approvalsReviewer).toBe("auto_review");
  });

  it("forces prompting when explicit no-prompt config cannot use model-backed review", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          approvalsReviewer: "auto_review",
        },
      },
      modelProvider: "lmstudio",
      model: "local-model",
    });

    expectRuntimePolicy(runtime, userReviewPolicy);
    expect(shouldAutoApproveCodexAppServerApprovals(runtime)).toBe(false);
  });

  it("parses dynamic tool controls", () => {
    expect(
      readCodexPluginConfig({
        codexDynamicToolsLoading: "direct",
        codexDynamicToolsExclude: ["custom_tool"],
      }),
    ).toEqual({
      codexDynamicToolsLoading: "direct",
      codexDynamicToolsExclude: ["custom_tool"],
    });
  });

  it("parses app-server experimental flags", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          experimental: {
            sandboxExecServer: true,
          },
        },
      }).appServer?.experimental,
    ).toEqual({ sandboxExecServer: true });
    expect(
      isCodexSandboxExecServerEnabled(undefined, {
        placementExecutionMode: "remote-exec",
      }),
    ).toBe(true);
  });

  it("rejects the retired dynamic tool profile key", () => {
    expect(
      readCodexPluginConfig({
        codexDynamicToolsProfile: "openclaw-compat",
        codexDynamicToolsLoading: "direct",
      }),
    ).toEqual({});
  });

  it("parses native Codex plugin policy without treating wildcard as supported config", () => {
    const config = readCodexPluginConfig({
      appServer: { mode: "guardian" },
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: false,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
            allow_destructive_actions: true,
          },
          slack: {
            enabled: false,
            marketplaceName: "openai-curated",
            pluginName: "slack",
          },
        },
      },
    });

    expect(config.appServer?.mode).toBe("guardian");
    expect(config.codexPlugins?.enabled).toBe(true);

    const policy = resolveCodexPluginsPolicy(config);
    expect(policy).toEqual({
      configured: true,
      enabled: true,
      allowAllPlugins: false,
      allowDestructiveActions: false,
      destructiveApprovalMode: "deny",
      pluginPolicies: [
        {
          configKey: "google-calendar",
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "allow",
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

  it("parses auto native Codex plugin destructive policy", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
          slack: {
            marketplaceName: "openai-curated",
            pluginName: "slack",
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
          enabled: true,
          allowDestructiveActions: false,
          destructiveApprovalMode: "deny",
        },
      ],
    });
  });

  it("rejects unsupported native Codex plugin destructive policy strings", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "always",
        plugins: {
          slack: {
            marketplaceName: "openai-curated",
            pluginName: "slack",
          },
        },
      },
    });

    expect(config.codexPlugins).toBeUndefined();
  });

  it("accepts custom native plugin marketplace identities", () => {
    const marketplaceName = "custom_market-42";
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        plugins: {
          gmail: {
            marketplaceName,
            pluginName: "gmail",
          },
        },
      },
    });

    expect(resolveCodexPluginsPolicy(config).pluginPolicies).toStrictEqual([
      expect.objectContaining({ marketplaceName, pluginName: "gmail" }),
    ]);
  });

  it.each(["", "../marketplace", "market/place", "market@place", " white-space", "trail "])(
    "rejects unsafe native plugin marketplace identity %j",
    (marketplaceName) => {
      const config = readCodexPluginConfig({
        codexPlugins: {
          enabled: true,
          plugins: {
            gmail: {
              marketplaceName,
              pluginName: "gmail",
            },
          },
        },
      });

      expect(config.codexPlugins).toBeUndefined();
      expect(resolveCodexPluginsPolicy(config).pluginPolicies).toStrictEqual([]);
    },
  );

  it("ignores an invalid marketplace identity when resolving raw native plugin policy", () => {
    const config = {
      codexPlugins: {
        enabled: true,
        plugins: {
          gmail: {
            marketplaceName: "../unsafe-marketplace",
            pluginName: "gmail",
          },
        },
      },
    };

    expect(resolveCodexPluginsPolicy(config).pluginPolicies).toStrictEqual([]);
  });

  it("requires native plugin support before exposing all connected account apps", () => {
    expect(resolveCodexPluginsPolicy({ codexPlugins: { allow_all_plugins: true } })).toEqual({
      configured: true,
      enabled: false,
      allowAllPlugins: false,
      allowDestructiveActions: true,
      destructiveApprovalMode: "allow",
      pluginPolicies: [],
    });
    expect(
      readCodexPluginConfig({ codexPlugins: { enabled: true, allow_all_plugins: "yes" } }),
    ).toEqual({});
  });

  it("treats configured and environment commands as explicit overrides", () => {
    expectFields(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { command: "/opt/codex/bin/codex" } },
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
      "configured start",
      {
        command: "/opt/codex/bin/codex",
        commandSource: "config",
      },
    );

    expectFields(
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
      "environment start",
      {
        command: "/usr/local/bin/codex",
        commandSource: "env",
      },
    );
  });

  it("uses the pinned managed package for ordinary turns and desktop ownership for Computer Use", () => {
    expect(resolveRuntimeForTest({ pluginConfig: {} }).start.managedCommandOrder).toBeUndefined();
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { homeScope: "user" } },
      }).start.managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveRuntimeForTest({
        pluginConfig: { computerUse: { enabled: true } },
      }).start.managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveRuntimeForTest({
        pluginConfig: {},
        managedCommandOrder: "desktop-first",
      }).start.managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { homeScope: "user" } },
        managedCommandOrder: "package-first",
      }).start.managedCommandOrder,
    ).toBe("package-first");
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
    for (const codexConfigToml of [
      '[plugins."computer-use@openai-bundled"]\n',
      'plugins."computer-use@openai-bundled".enabled = true\n',
      'plugins = { "computer-use@openai-bundled" = { enabled = true } }\n',
      '["plugins"."computer-use@openai-bundled".mcp_servers.computer_use]\n',
    ]) {
      expect(resolveForConfig(codexConfigToml)).toBe("desktop-first");
    }
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
    expect(
      resolveCodexAppServerStartOptionsForAgent({
        startOptions: customIdentityStartOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml: '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      }).managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveCodexAppServerStartOptionsForAgent({
        startOptions: customIdentityStartOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml:
          '[plugins."computer-use@openai-bundled"]\nenabled = false\n[plugins."custom-computer-use@local"]\nenabled = true\n',
      }).managedCommandOrder,
    ).toBe("desktop-first");

    const privateStartOptions = resolveRuntimeForTest({
      pluginConfig: { appServer: { homeScope: "user" } },
      managedCommandOrder: "package-first",
    }).start;
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
        resolveCodexAppServerStartOptionsForAgent({
          startOptions,
          agentDir,
        }).managedCommandOrder,
      ).toBe("desktop-first");
    });
  });

  it("uses desktop-first when persisted Codex state cannot be read", async () => {
    await withTempDir("openclaw-codex-unreadable-home-", async (agentDir) => {
      const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
      await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
      await fs.mkdir(path.join(agentDir, "codex-home", "config.toml"));

      expect(
        resolveCodexAppServerStartOptionsForAgent({
          startOptions,
          agentDir,
        }).managedCommandOrder,
      ).toBe("desktop-first");
    });
  });

  it("does not change explicit commands when Computer Use is enabled", () => {
    const start = resolveRuntimeForTest({
      pluginConfig: {
        appServer: { command: "/opt/codex/bin/codex" },
        computerUse: { enabled: true },
      },
    }).start;

    expectFields(start, "configured Computer Use start", {
      command: "/opt/codex/bin/codex",
      commandSource: "config",
    });
    expect(start.managedCommandOrder).toBeUndefined();
  });

  it("rejects Codex app-server command overrides that include inline arguments", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            command:
              "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
          },
        },
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

  it("preserves executable paths that contain spaces", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: { appServer: { command: "C:\\Program Files\\OpenAI Codex\\codex.exe" } },
      env: {},
    });

    expect(runtime.start.command).toBe("C:\\Program Files\\OpenAI Codex\\codex.exe");
  });

  it("resolves Computer Use setup from plugin config and environment fallbacks", () => {
    expect(
      resolveCodexComputerUseConfig({
        pluginConfig: {
          computerUse: {
            autoInstall: true,
            marketplaceName: "desktop-tools",
          },
        },
        env: {
          OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_NAME: "env-fallback-plugin",
        },
      }),
    ).toEqual({
      enabled: true,
      autoInstall: true,
      marketplaceDiscoveryTimeoutMs: 60_000,
      liveTestTimeoutMs: 60_000,
      toolCallTimeoutMs: 60_000,
      healthCheckEnabled: false,
      healthCheckIntervalMinutes: 60,
      pluginCacheMode: "independent",
      strictReadiness: false,
      autoRepair: false,
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
        enabled: true,
        autoInstall: true,
        marketplaceDiscoveryTimeoutMs: 30_000,
        liveTestTimeoutMs: 60_000,
        toolCallTimeoutMs: 60_000,
        healthCheckEnabled: false,
        healthCheckIntervalMinutes: 60,
        pluginCacheMode: "independent",
        strictReadiness: false,
        autoRepair: false,
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
        {
          enabled: true,
          marketplaceDiscoveryTimeoutMs: 60_000,
          liveTestTimeoutMs: 60_000,
          toolCallTimeoutMs: 60_000,
          healthCheckEnabled: false,
          healthCheckIntervalMinutes: 60,
          pluginCacheMode: "independent",
          strictReadiness: false,
          autoRepair: false,
        },
      );
    }
  });

  it("resolves Computer Use operational policy knobs", () => {
    expectFields(
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
      "computer use config",
      {
        enabled: true,
        liveTestTimeoutMs: 45_000,
        toolCallTimeoutMs: 55_000,
        healthCheckEnabled: true,
        healthCheckIntervalMinutes: 120,
        pluginCacheMode: "independent",
        strictReadiness: true,
        autoRepair: true,
      },
    );

    expectFields(
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
      "computer use config",
      {
        healthCheckEnabled: true,
        healthCheckIntervalMinutes: 60,
        pluginCacheMode: "independent",
        strictReadiness: true,
        autoRepair: true,
      },
    );
  });

  it("allows plugin config to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      modelProvider: "openai",
      env: {},
    });

    expectRuntimePolicy(runtime, autoReviewPolicy);
  });

  it("uses user approvals for explicit guardian mode when model provider is unknown", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      env: {},
    });

    expectRuntimePolicy(runtime, userReviewPolicy);
  });

  it("allows environment mode fallback to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      env: { OPENCLAW_CODEX_APP_SERVER_MODE: "guardian" },
    });

    expectRuntimePolicy(runtime, autoReviewPolicy);
  });

  it("maps normalized OpenClaw auto exec mode to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      modelProvider: "openai",
    });

    expectRuntimePolicy(runtime, autoReviewPolicy);
  });

  it("forces guarded app-server policy fields for auto mode", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
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
    });

    expectRuntimePolicy(runtime, autoReviewPolicy);
  });

  it("preserves explicit read-only app-server sandbox for auto mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "read-only",
          approvalsReviewer: "user",
        },
      },
      execMode: "auto",
      modelProvider: "openai",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      modelProvider: "openai",
      env: {
        OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expectRuntimePolicy(configRuntime, readOnlyAutoReviewPolicy);
    expectRuntimePolicy(envRuntime, readOnlyAutoReviewPolicy);
  });

  it.each(["deny", "allowlist"] as const)(
    "blocks Codex app-server local execution for normalized OpenClaw %s exec mode",
    (execMode) => {
      expect(() =>
        resolveRuntimeForTest({
          pluginConfig: {},
          execMode,
        }),
      ).toThrow(
        `Codex app-server local execution is unavailable because effective tools.exec.mode=${execMode}`,
      );
    },
  );

  it("maps normalized OpenClaw ask exec mode away from Codex yolo", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
    });

    expectRuntimePolicy(runtime, userReviewPolicy);
  });

  it("keeps user approvals for ask mode with explicit legacy guardian mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      execMode: "ask",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
      env: { OPENCLAW_CODEX_APP_SERVER_MODE: "guardian" },
    });

    expectRuntimePolicy(configRuntime, userReviewPolicy);
    expectRuntimePolicy(envRuntime, userReviewPolicy);
  });

  it("overrides explicit app-server policy fields for ask mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          approvalsReviewer: "auto_review",
        },
      },
      execMode: "ask",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
      env: {
        OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "danger-full-access",
      },
    });

    expectRuntimePolicy(configRuntime, userReviewPolicy);
    expectRuntimePolicy(envRuntime, userReviewPolicy);
  });

  it("preserves explicit read-only app-server sandbox for ask mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "read-only",
          approvalsReviewer: "auto_review",
        },
      },
      execMode: "ask",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
      env: {
        OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expectRuntimePolicy(configRuntime, readOnlyUserReviewPolicy);
    expectRuntimePolicy(envRuntime, readOnlyUserReviewPolicy);
  });

  it("fails closed when normalized OpenClaw ask mode cannot use user approvals", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        execMode: "ask",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
      }),
    ).toThrow("tools.exec.mode=ask requires Codex app-server user approvals");
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: { appServer: { mode: "guardian" } },
        execMode: "ask",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
      }),
    ).toThrow("tools.exec.mode=ask requires Codex app-server user approvals");
  });

  it("fails closed when Guardian local-model fallback needs user approvals but requirements disallow them", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: { appServer: { mode: "guardian" } },
        modelProvider: "lmstudio",
        model: "local-model",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
      }),
    ).toThrow("tools.exec.mode=ask requires Codex app-server user approvals");
  });

  it.each([
    {
      execMode: "auto",
      policies: ["never"],
      error: "tools.exec.mode=auto requires Codex app-server prompting approvals",
    },
    {
      execMode: "ask",
      policies: ["never"],
      error: "tools.exec.mode=ask requires Codex app-server prompting approvals",
    },
  ] as const)(
    "fails closed when normalized OpenClaw $execMode mode can only use $policies approvals",
    ({ execMode, policies, error }) => {
      expect(() =>
        resolveRuntimeForTest({
          pluginConfig: {},
          execMode,
          requirementsToml: `allowed_approval_policies = [${policies
            .map((policy) => `"${policy}"`)
            .join(", ")}]\n`,
        }),
      ).toThrow(error);
    },
  );

  it.each([
    { execMode: "auto" as const, approvalsReviewer: "auto_review" },
    { execMode: "ask" as const, approvalsReviewer: "user" },
  ])("honors managed prompting approvals for OpenClaw $execMode mode", (expected) => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: expected.execMode,
      modelProvider: "openai",
      requirementsToml: 'allowed_approval_policies = ["untrusted", "never"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      approvalsReviewer: expected.approvalsReviewer,
    });
  });

  it("keeps normalized OpenClaw full exec mode on default Codex yolo", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "full",
    });

    expectRuntimePolicy(runtime, fullAccessPolicy);
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

  it("keeps auto mode prompting when requirements use the on-failure alias", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      requirementsToml:
        'allowed_sandbox_modes = ["read-only"]\nallowed_approval_policies = ["on-failure"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expectRuntimePolicy(runtime, readOnlyUserReviewPolicy);
  });

  it("prefers the normalized on-request alias over a permitted never policy", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      requirementsToml:
        'allowed_sandbox_modes = ["danger-full-access", "read-only"]\nallowed_approval_policies = ["never", "on-failure"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expectRuntimePolicy(runtime, readOnlyUserReviewPolicy);
  });

  it.each([
    { modelProvider: undefined, model: undefined },
    { modelProvider: "lmstudio", model: "local-model" },
  ])(
    "uses user approvals for local-model auto exec before requirements validation",
    ({ modelProvider, model }) => {
      const runtime = resolveRuntimeForTest({
        pluginConfig: {},
        execMode: "auto",
        modelProvider,
        model,
        requirementsToml:
          'allowed_approval_policies = ["on-request"]\nallowed_approvals_reviewers = ["user"]\n',
      });

      expectRuntimePolicy(runtime, userReviewPolicy);
    },
  );

  it("keeps normalized OpenClaw auto mode when legacy app-server yolo was schema-defaulted", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          command: "codex",
          mode: "yolo",
          transport: "stdio",
          requestTimeoutMs: 60_000,
        },
        codexDynamicToolsLoading: "searchable",
        codexDynamicToolsExclude: [],
      },
      execMode: "auto",
      modelProvider: "openai",
    });

    expectRuntimePolicy(runtime, autoReviewPolicy);
    expectFields(runtime, "runtime start", {
      start: {
        transport: "stdio",
        command: "codex",
        commandSource: "config",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
        homeScope: "agent",
      },
    });
  });

  it.each(["always"] as const)(
    "keeps legacy full exec security with ask=%s on per-command Codex policy",
    (ask) => {
      const config = {
        tools: {
          exec: {
            security: "full",
            ask,
          },
        },
      } satisfies OpenClawConfig;
      const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({ config });

      expectRuntimePolicy(
        resolveRuntimeForTest({
          pluginConfig: {
            appServer: {
              mode: "yolo",
              approvalPolicy: "never",
              sandbox: "workspace-write",
              approvalsReviewer: "auto_review",
            },
          },
          execPolicy,
        }),
        perCommandPolicy,
      );
    },
  );

  it("keeps legacy full exec security with ask=on-miss on default Codex yolo", () => {
    const config = {
      tools: {
        exec: {
          security: "full",
          ask: "on-miss",
        },
      },
    } satisfies OpenClawConfig;
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({ config });

    expectRuntimePolicy(resolveRuntimeForTest({ execPolicy }), fullAccessPolicy);
  });

  it("fails closed when legacy full exec with ask cannot use full Codex sandbox", () => {
    const config = {
      tools: {
        exec: {
          security: "full",
          ask: "always",
        },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveRuntimeForTest({
        execPolicy: resolveOpenClawExecPolicyForCodexAppServer({ config }),
        requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
      }),
    ).toThrow("legacy full exec security with ask requires Codex app-server danger-full-access");
  });

  it("fails closed when managed policy forbids mandatory per-command approvals", () => {
    const config = {
      tools: { exec: { security: "full", ask: "always" } },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveRuntimeForTest({
        execPolicy: resolveOpenClawExecPolicyForCodexAppServer({ config }),
        requirementsToml: 'allowed_approval_policies = ["on-request", "never"]',
      }),
    ).toThrow("tools.exec.ask=always requires Codex app-server per-command approvals");
  });

  it("honors managed policy that permits mandatory per-command approvals", () => {
    const config = {
      tools: { exec: { security: "full", ask: "always" } },
    } satisfies OpenClawConfig;

    expectRuntimePolicy(
      resolveRuntimeForTest({
        execPolicy: resolveOpenClawExecPolicyForCodexAppServer({ config }),
        requirementsToml: 'allowed_approval_policies = ["on-request", "untrusted"]',
      }),
      perCommandPolicy,
    );
  });

  it("clamps legacy full exec with ask when an OpenClaw sandbox is active", () => {
    const config = {
      tools: {
        exec: {
          security: "full",
          ask: "always",
        },
      },
    } satisfies OpenClawConfig;

    expectRuntimePolicy(
      resolveRuntimeForTest({
        execPolicy: resolveOpenClawExecPolicyForCodexAppServer({ config }),
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
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      approvals: {
        version: 1,
        defaults: {
          security: "deny",
        },
        agents: {},
      },
    });

    expect(execPolicy.mode).toBe("deny");
    let error: unknown;
    try {
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          },
        },
        execPolicy,
      });
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

  it("applies host exec approval ask floors before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      approvals: {
        version: 1,
        defaults: {
          ask: "always",
        },
        agents: {},
      },
    });

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "workspace-write",
            approvalsReviewer: "auto_review",
          },
        },
        execPolicy,
      }),
      perCommandPolicy,
    );
  });

  it("does not apply host exec approval floors to an explicit full session", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      permissionMode: "full",
      config: {
        tools: {
          exec: {
            mode: "ask",
          },
        },
      },
      approvals: {
        version: 1,
        defaults: {
          ask: "always",
        },
        agents: {},
      },
    });

    expect(execPolicy).toMatchObject({ mode: "full", security: "full", ask: "off" });
  });

  it("preserves explicit read-only sandbox for host exec approval ask floors", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      approvals: {
        version: 1,
        defaults: {
          ask: "always",
        },
        agents: {},
      },
    });

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "read-only",
            approvalsReviewer: "auto_review",
          },
        },
        execPolicy,
      }),
      {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      },
    );
  });

  it("applies agent-scoped exec approval security floors before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      agentId: "codex-agent",
      approvals: {
        version: 1,
        defaults: {
          security: "full",
        },
        agents: {
          "codex-agent": {
            security: "deny",
          },
        },
      },
    });

    expect(execPolicy.mode).toBe("deny");
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          },
        },
        execPolicy,
      }),
    ).toThrow(
      "Codex app-server local execution is unavailable because effective tools.exec.mode=deny",
    );
  });

  it("applies agent-scoped exec approval ask floors before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      agentId: "codex-agent",
      approvals: {
        version: 1,
        defaults: {
          ask: "off",
        },
        agents: {
          "codex-agent": {
            ask: "always",
          },
        },
      },
    });

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "workspace-write",
            approvalsReviewer: "auto_review",
          },
        },
        execPolicy,
      }),
      perCommandPolicy,
    );
  });

  it("accepts the latest auto_review reviewer and legacy guardian_subagent alias", () => {
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { approvalsReviewer: "auto_review" } },
        modelProvider: "openai",
        env: {},
      }).approvalsReviewer,
    ).toBe("auto_review");
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { approvalsReviewer: "guardian_subagent" } },
        modelProvider: "openai",
        env: {},
      }).approvalsReviewer,
    ).toBe("guardian_subagent");
  });

  it("ignores removed OPENCLAW_CODEX_APP_SERVER_GUARDIAN fallback", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      env: { OPENCLAW_CODEX_APP_SERVER_GUARDIAN: "1" },
    });

    expectRuntimePolicy(runtime, fullAccessPolicy);
  });

  it("normalizes the deprecated approval-policy config alias without dropping other settings", () => {
    const pluginConfig = readCodexPluginConfig({
      appServer: {
        mode: "guardian",
        approvalPolicy: "on-failure",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        command: "/opt/codex/bin/codex",
      },
    });
    expect(pluginConfig.appServer).toMatchObject({
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      command: "/opt/codex/bin/codex",
    });

    const runtime = resolveRuntimeForTest({
      pluginConfig,
      env: {},
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
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

  it("derives distinct shared-client keys for distinct auth tokens without exposing them", () => {
    const first = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_first",
      headers: {},
    });
    const second = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_second",
      headers: {},
    });

    expect(first).not.toEqual(second);
    expect(
      codexAppServerStartOptionsKey({
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok_first",
        headers: {},
      }),
    ).toEqual(first);
    expect(first).not.toContain("tok_first");
    expect(second).not.toContain("tok_second");
  });

  it("derives distinct shared-client keys for distinct auth binding fingerprints", () => {
    const options = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: {},
    };
    const first = codexAppServerStartOptionsKey(options, {
      authProfileId: "openai:work",
      authBindingFingerprint: "auth-fingerprint-a",
    });
    const second = codexAppServerStartOptionsKey(options, {
      authProfileId: "openai:work",
      authBindingFingerprint: "auth-fingerprint-b",
    });

    expect(first).not.toEqual(second);
  });

  it("derives distinct shared-client keys for distinct env values without exposing them", () => {
    const first = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
      env: { OPENAI_API_KEY: "sk-first" },
    });
    const second = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
      env: { OPENAI_API_KEY: "sk-second" },
    });

    expect(first).not.toEqual(second);
    expect(
      codexAppServerStartOptionsKey({
        transport: "stdio",
        command: "codex",
        args: ["app-server"],
        headers: {},
        env: { OPENAI_API_KEY: "sk-first" },
      }),
    ).toEqual(first);
    expect(first).not.toContain("sk-first");
    expect(second).not.toContain("sk-second");
  });

  it("derives distinct shared-client keys for managed binary order", () => {
    const packageFirst = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      commandSource: "managed",
      args: ["app-server"],
      headers: {},
    });
    const desktopFirst = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
      args: ["app-server"],
      headers: {},
    });

    expect(packageFirst).not.toEqual(desktopFirst);
  });

  it("derives distinct shared-client keys for native Computer Use identities", () => {
    const keyFor = (pluginName: string) =>
      codexAppServerStartOptionsKey({
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        managedComputerUsePluginNames: ["computer-use", pluginName],
        args: ["app-server"],
        headers: {},
      });

    expect(keyFor("custom-a")).not.toEqual(keyFor("custom-b"));
  });

  it("derives distinct shared-client keys for distinct headers without exposing them", () => {
    const first = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      headers: {
        Authorization: "Bearer first",
        "x-codex-client-session-token": "session-first",
      },
    });
    const second = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      headers: {
        Authorization: "Bearer second",
        "x-codex-client-session-token": "session-second",
      },
    });

    expect(first).not.toEqual(second);
    expect(
      codexAppServerStartOptionsKey({
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        headers: {
          Authorization: "Bearer first",
          "x-codex-client-session-token": "session-first",
        },
      }),
    ).toEqual(first);
    expect(first).not.toContain("Bearer first");
    expect(first).not.toContain("session-first");
    expect(second).not.toContain("Bearer second");
    expect(second).not.toContain("session-second");
  });

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

  it("derives distinct shared-client keys for distinct agent dirs", () => {
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: {},
    };

    expect(codexAppServerStartOptionsKey(startOptions, { agentDir: "/tmp/agent-a" })).not.toEqual(
      codexAppServerStartOptionsKey(startOptions, { agentDir: "/tmp/agent-b" }),
    );
  });

  it("derives distinct shared-client keys for distinct process working directories", () => {
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: {},
    };

    expect(codexAppServerStartOptionsKey({ ...startOptions, cwd: "/tmp/project-a" })).not.toEqual(
      codexAppServerStartOptionsKey({ ...startOptions, cwd: "/tmp/project-b" }),
    );
  });

  it("publishes stable defaults without schema-defaulting mode-derived policy fields", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: {
        properties: {
          appServer: {
            properties: Record<string, { default?: unknown }>;
          };
        };
      };
      uiHints: Record<string, unknown>;
    };
    const appServerProperties = manifest.configSchema.properties.appServer.properties;
    const runtime = resolveRuntimeForTest();
    for (const key of retiredTurnIdleTimeoutKeys) {
      expect(appServerProperties).not.toHaveProperty(key);
      expect(manifest.uiHints).not.toHaveProperty([`appServer.${key}`]);
      expect(runtime).not.toHaveProperty(key);
    }

    expect(appServerProperties.mode?.default).toBeUndefined();
    expect(appServerProperties.command?.default).toBeUndefined();
    expect(appServerProperties.approvalPolicy?.default).toBeUndefined();
    expect(appServerProperties.sandbox?.default).toBeUndefined();
    expect(appServerProperties.approvalsReviewer?.default).toBeUndefined();
    expect(appServerProperties.loopDetectionPreToolUseRelay?.default).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
