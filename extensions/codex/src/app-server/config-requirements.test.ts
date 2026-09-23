import { describe, expect, it } from "vitest";
import {
  resolveCodexAppServerRuntimeOptions,
  withMcpElicitationsApprovalPolicy,
} from "./config.js";
import { expectRuntimePolicy, resolveRuntimeForTest } from "./config.test-support.js";

describe("Codex app-server requirements", () => {
  it("uses user approvals when requirements force prompting but model provider is unknown", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("defaults native OpenAI Codex approvals to guardian when requirements disallow full access", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it.each([
    'allowed_sandbox_modes = ["read-only"]\n',
    '"allowed_sandbox_modes" = ["read-only"]\n',
    String.raw`'allowed_sandbox_modes' = ["read\u002donly"]`,
  ])(
    "uses read-only sandbox when native requirements only allow read-only: %s",
    (requirementsToml) => {
      const runtime = resolveRuntimeForTest({
        pluginConfig: {},
        modelProvider: "openai",
        requirementsToml,
      });

      expectRuntimePolicy(runtime, {
        approvalPolicy: "on-request",
        sandbox: "read-only",
        approvalsReviewer: "auto_review",
      });
    },
  );

  it("defaults native Codex approvals to guardian when requirements disallow never approval", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it.each([
    { policies: ["untrusted"], description: "only the managed internal policy" },
    { policies: ["untrusted", "never"], description: "managed and unrestricted policies" },
  ])("preserves $description without weakening Codex approvals", ({ policies }) => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: `allowed_approval_policies = [${policies
        .map((policy) => `"${policy}"`)
        .join(", ")}]\n`,
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
    expect(runtime.approvalPolicySource).toBe("requirements");
    expect(withMcpElicitationsApprovalPolicy(runtime.approvalPolicy)).toBe("untrusted");
  });

  it("normalizes the deprecated requirements on-failure alias to on-request", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: 'allowed_approval_policies = ["on-failure"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("keeps native Codex approvals unchained when requirements allow never approval", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approval_policies = ["never"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("defaults native Codex approvals to guardian when requirements disallow user reviewer", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("selects an allowed reviewer when sandbox requirements force guardian defaults", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml:
        'allowed_sandbox_modes = ["read-only", "workspace-write"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("ignores quoted sandbox modes inside requirements comments", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: `allowed_sandbox_modes = [
  "read-only",
  # "danger-full-access",
  "workspace-write",
]
`,
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("applies the first matching remote sandbox requirements before resolving local stdio defaults", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      hostName: "BUILD-01.EXAMPLE.COM.",
      requirementsToml: `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]

[[remote_sandbox_config]]
hostname_patterns = ["build-01.example.com"]
allowed_sandbox_modes = ["read-only", "danger-full-access"]
`,
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it.each(["", "# Remote build hosts have separate sandbox requirements.\n".repeat(4)])(
    "ignores non-matching remote-only sandbox requirements after comments: %s",
    (comment) => {
      const runtime = resolveRuntimeForTest({
        pluginConfig: {},
        hostName: "laptop.example.com",
        requirementsToml: `${comment}[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]
`,
      });

      expectRuntimePolicy(runtime, {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      });
    },
  );

  it("reads local requirements policy from the configured requirements path", () => {
    const readPaths: string[] = [];
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: {},
      modelProvider: "openai",
      requirementsPath: "/custom/codex/requirements.toml",
      readRequirementsFile: (requirementsPath) => {
        readPaths.push(requirementsPath);
        return 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
      },
    });

    expect(readPaths).toEqual(["/custom/codex/requirements.toml"]);
    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("reads local requirements policy from the Codex Windows requirements path", () => {
    const readPaths: string[] = [];
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: { ProgramData: "D:\\ManagedData" },
      modelProvider: "openai",
      platform: "win32",
      readRequirementsFile: (requirementsPath) => {
        readPaths.push(requirementsPath);
        return 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
      },
    });

    expect(readPaths).toEqual(["D:\\ManagedData\\OpenAI\\Codex\\requirements.toml"]);
    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("keeps native Codex approvals unchained when requirements allow full access", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml:
        'allowed_sandbox_modes = ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("keeps native Codex approvals unchained when requirements are malformed", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: "allowed_sandbox_modes = [read-only]\n",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("does not apply local requirements policy to websocket app-server transports", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
        },
      },
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("keeps explicit yolo mode when requirements disallow full access", () => {
    const requirementsToml = 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { mode: "yolo" } },
        requirementsToml,
      }),
      {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      },
    );
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_MODE: "yolo" },
        requirementsToml,
      }),
      {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      },
    );
  });
});
