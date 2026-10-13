import { beforeEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals-store.js";
import {
  buildEmbeddedSandboxInfo,
  resolveEmbeddedSandboxInfoExecPolicy,
} from "./embedded-agent-runner/sandbox-info.js";
import type { SandboxContext } from "./sandbox.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const sandbox = (overrides: Partial<SandboxContext> = {}) =>
  createSandboxTestContext({
    overrides: {
      workspaceDir: "/tmp/openclaw-sandbox",
      agentWorkspaceDir: "/tmp/openclaw-workspace",
      workspaceAccess: "none",
      browserAllowHostControl: true,
      browser: {
        bridgeUrl: "http://localhost:9222",
        noVncUrl: "http://localhost:6080",
        containerName: "openclaw-sbx-browser-test",
      },
      ...overrides,
    },
  });
const elevation = { enabled: true, allowed: true, defaultLevel: "full" } as const;
const blocked = {
  allowed: true,
  defaultLevel: "full",
  fullAccessAvailable: false,
  fullAccessBlockedReason: "host-policy",
};
const promptInfo = {
  enabled: true,
  workspaceDir: "/tmp/openclaw-sandbox",
  containerWorkspaceDir: "/workspace",
  workspaceAccess: "none",
  agentWorkspaceMount: undefined,
  browserBridgeUrl: "http://localhost:9222",
  hostBrowserAllowed: true,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync").mockResolvedValue({
    version: 1,
    agents: {},
  });
});

describe("embedded sandbox reporting", () => {
  it("omits missing sandbox information", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });
  it("maps sandbox context into prompt information", () => {
    expect(buildEmbeddedSandboxInfo(sandbox())).toEqual(promptInfo);
  });
  it("never advertises host execution for a required sandbox", () => {
    expect(
      buildEmbeddedSandboxInfo(sandbox({ required: true }), {
        ...elevation,
        fullAccessAvailable: true,
      })?.elevated,
    ).toEqual({
      allowed: false,
      defaultLevel: "off",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "host-policy",
    });
  });
  it("preserves runtime-level full-access unavailability", () => {
    expect(
      buildEmbeddedSandboxInfo(sandbox(), {
        ...elevation,
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      })?.elevated,
    ).toEqual({
      ...blocked,
      fullAccessBlockedReason: "runtime",
    });
  });
  it("uses the effective configured exec policy", async () => {
    const policy = await resolveEmbeddedSandboxInfoExecPolicy(
      {
        config: { tools: { exec: { mode: "auto" } } },
        agentId: "main",
        sandboxAvailable: true,
      },
      {},
    );
    expect(buildEmbeddedSandboxInfo(sandbox(), elevation, policy)?.elevated).toEqual(blocked);
  });
  it("advertises full access only when host approval floors allow it", () => {
    const fullPolicy = { mode: "full", security: "full", ask: "off" } as const;
    expect(
      buildEmbeddedSandboxInfo(sandbox(), elevation, fullPolicy, {
        security: "allowlist",
        ask: "off",
      })?.elevated,
    ).toEqual(blocked);
    expect(
      buildEmbeddedSandboxInfo(sandbox(), elevation, fullPolicy, {
        security: "full",
        ask: "always",
      })?.elevated,
    ).toEqual(blocked);
    expect(
      buildEmbeddedSandboxInfo(
        sandbox(),
        elevation,
        { ...fullPolicy, ask: "on-miss" },
        { security: "full", ask: "on-miss" },
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: true,
    });
  });
});
