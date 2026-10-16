import { describe, expect, it } from "vitest";
import {
  resolveCodexAppServerRuntimeOptions,
  withMcpElicitationsApprovalPolicy,
} from "./config.js";
import { expectRuntimePolicy, resolveRuntimeForTest } from "./config.test-support.js";

const guardian = {
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  approvalsReviewer: "auto_review",
};
const unrestricted = {
  approvalPolicy: "never",
  sandbox: "danger-full-access",
  approvalsReviewer: "user",
};
const restrictedSandbox = 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';

describe("Codex app-server requirements", () => {
  it.each<
    [string, Parameters<typeof resolveRuntimeForTest>[0], Parameters<typeof expectRuntimePolicy>[1]]
  >([
    [
      "uses user approvals when the model provider is unknown",
      { requirementsToml: restrictedSandbox },
      { ...guardian, approvalsReviewer: "user" },
    ],
    [
      "reads quoted keys and escaped read-only sandbox values",
      {
        modelProvider: "openai",
        requirementsToml: String.raw`'allowed_sandbox_modes' = ["read\u002donly"]`,
      },
      { ...guardian, sandbox: "read-only" },
    ],
    [
      "uses guardian when never approval is disallowed",
      { modelProvider: "openai", requirementsToml: 'allowed_approval_policies = ["on-request"]' },
      guardian,
    ],
    [
      "normalizes the deprecated on-failure alias",
      { modelProvider: "openai", requirementsToml: 'allowed_approval_policies = ["on-failure"]' },
      guardian,
    ],
    [
      "uses guardian when the user reviewer is disallowed",
      {
        modelProvider: "openai",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]',
      },
      guardian,
    ],
    [
      "selects the allowed user reviewer under sandbox restrictions",
      { requirementsToml: `${restrictedSandbox}allowed_approvals_reviewers = ["user"]` },
      { ...guardian, approvalsReviewer: "user" },
    ],
    [
      "ignores quoted sandbox modes inside comments",
      {
        modelProvider: "openai",
        requirementsToml: `allowed_sandbox_modes = [
  "read-only",
  # "danger-full-access",
  "workspace-write",
]`,
      },
      guardian,
    ],
    [
      "applies the first matching remote sandbox requirements",
      {
        modelProvider: "openai",
        hostName: "BUILD-01.EXAMPLE.COM.",
        requirementsToml: `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]

[[remote_sandbox_config]]
hostname_patterns = ["build-01.example.com"]
allowed_sandbox_modes = ["read-only", "danger-full-access"]`,
      },
      guardian,
    ],
    [
      "ignores non-matching remote-only requirements after comments",
      {
        hostName: "laptop.example.com",
        requirementsToml: `${"# Remote build hosts have separate sandbox requirements.\n".repeat(4)}[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]`,
      },
      unrestricted,
    ],
    [
      "stays unchained when never approval is allowed",
      { requirementsToml: 'allowed_approval_policies = ["never"]' },
      unrestricted,
    ],
    [
      "stays unchained when full access is allowed",
      {
        requirementsToml:
          'allowed_sandbox_modes = ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"]',
      },
      unrestricted,
    ],
    [
      "stays unchained when requirements are malformed",
      { requirementsToml: "allowed_sandbox_modes = [read-only]" },
      unrestricted,
    ],
    [
      "does not apply local requirements to websocket transports",
      {
        pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" } },
        requirementsToml: restrictedSandbox,
      },
      unrestricted,
    ],
  ])("%s", (_name, params, policy) => {
    expectRuntimePolicy(resolveRuntimeForTest({ pluginConfig: {}, ...params }), policy);
  });

  it("preserves managed approval over an allowed unrestricted policy", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: 'allowed_approval_policies = ["untrusted", "never"]',
    });
    expectRuntimePolicy(runtime, { ...guardian, approvalPolicy: "untrusted" });
    expect(withMcpElicitationsApprovalPolicy(runtime.approvalPolicy)).toBe("untrusted");
  });

  it.each([
    {
      name: "configured path",
      options: { requirementsPath: "/custom/codex/requirements.toml" },
      expected: "/custom/codex/requirements.toml",
    },
    {
      name: "Windows ProgramData path",
      options: { platform: "win32" as const, env: { ProgramData: "D:\\ManagedData" } },
      expected: "D:\\ManagedData\\OpenAI\\Codex\\requirements.toml",
    },
  ])("reads local requirements from the $name", ({ options, expected }) => {
    const readPaths: string[] = [];
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: {},
      modelProvider: "openai",
      ...options,
      readRequirementsFile: (requirementsPath) => {
        readPaths.push(requirementsPath);
        return restrictedSandbox;
      },
    });
    expect(readPaths).toEqual([expected]);
    expectRuntimePolicy(runtime, guardian);
  });

  it("keeps explicit yolo mode when requirements disallow full access", () => {
    for (const params of [
      { pluginConfig: { appServer: { mode: "yolo" } } },
      { pluginConfig: {}, env: { OPENCLAW_CODEX_APP_SERVER_MODE: "yolo" } },
    ]) {
      expectRuntimePolicy(
        resolveRuntimeForTest({ ...params, requirementsToml: restrictedSandbox }),
        unrestricted,
      );
    }
  });
});
