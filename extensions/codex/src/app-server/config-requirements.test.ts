import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveCodexAppServerRuntimeOptions,
  withMcpElicitationsApprovalPolicy,
} from "./config.js";
import { expectRuntimePolicy, resolveRuntimeForTest } from "./config.test-support.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
afterEach(() => vi.mocked(fs.readFileSync).mockReset());

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
type RuntimeParams = Parameters<typeof resolveRuntimeForTest>[0];
const openai = { modelProvider: "openai" };
const userGuardian = { ...guardian, approvalsReviewer: "user" };
const remoteBuild = `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]`;

describe("Codex app-server requirements", () => {
  it.each<[string, Parameters<typeof expectRuntimePolicy>[1], RuntimeParams?]>([
    [restrictedSandbox, userGuardian],
    [
      String.raw`'allowed_sandbox_modes' = ["read\u002donly"]`,
      { ...guardian, sandbox: "read-only" },
      openai,
    ],
    ['allowed_approval_policies = ["on-request"]', guardian, openai],
    ['allowed_approval_policies = ["on-failure"]', guardian, openai],
    ['allowed_approvals_reviewers = ["auto_review"]', guardian, openai],
    [`${restrictedSandbox}allowed_approvals_reviewers = ["user"]`, userGuardian],
    [
      `allowed_sandbox_modes = [
  "read-only",
  # "danger-full-access",
  "workspace-write",
]`,
      guardian,
      openai,
    ],
    [
      `${remoteBuild}
[[remote_sandbox_config]]
hostname_patterns = ["build-01.example.com"]
allowed_sandbox_modes = ["read-only", "danger-full-access"]`,
      guardian,
      { ...openai, hostName: "BUILD-01.EXAMPLE.COM." },
    ],
    [
      `${"# Remote build hosts have separate sandbox requirements.\n".repeat(4)}${remoteBuild}`,
      unrestricted,
      { hostName: "laptop.example.com" },
    ],
    ['allowed_approval_policies = ["never"]', unrestricted],
    ['allowed_sandbox_modes = ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"]', unrestricted],
    ["allowed_sandbox_modes = [read-only]", unrestricted],
    [
      restrictedSandbox,
      unrestricted,
      {
        pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" } },
      },
    ],
  ])("applies requirements %s as %j with %j", (requirementsToml, policy, options) => {
    expectRuntimePolicy(resolveRuntimeForTest({ requirementsToml, ...options }), policy);
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

  it.each<[Omit<NonNullable<RuntimeParams>, "pluginConfig">, string]>([
    [{ platform: "linux" }, "/etc/codex/requirements.toml"],
    [
      { platform: "win32", env: { ProgramData: "D:\\ManagedData" } },
      "D:\\ManagedData\\OpenAI\\Codex\\requirements.toml",
    ],
  ])("reads local requirements with %j", (options, expected) => {
    const readFile = vi.mocked(fs.readFileSync).mockClear().mockReturnValue(restrictedSandbox);
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: {},
      modelProvider: "openai",
      ...options,
    });
    expect(readFile).toHaveBeenCalledExactlyOnceWith(expected, "utf8");
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
