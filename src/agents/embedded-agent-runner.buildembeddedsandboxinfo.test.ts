// Covers prompt-facing sandbox metadata and full-access availability rules.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals-store.js";
import {
  buildEmbeddedSandboxInfo,
  resolveEmbeddedSandboxInfoExecPolicy,
} from "./embedded-agent-runner/sandbox-info.js";
import type { SandboxContext } from "./sandbox.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

function createSandboxContext(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({
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
}

const fullElevation = { enabled: true, allowed: true, defaultLevel: "full" } as const;
const blockedFullAccess = {
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

describe("buildEmbeddedSandboxInfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync").mockResolvedValue({
      version: 1,
      agents: {},
    });
  });

  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = createSandboxContext();

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      ...promptInfo,
    });
  });

  it("includes elevated info when allowed", () => {
    const sandbox = createSandboxContext({
      browserAllowHostControl: false,
      browser: undefined,
    });

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      }),
    ).toEqual({
      ...promptInfo,
      browserBridgeUrl: undefined,
      hostBrowserAllowed: false,
      elevated: {
        allowed: true,
        defaultLevel: "on",
        fullAccessAvailable: true,
      },
    });
  });

  it("never advertises elevated host execution for a required sandbox", () => {
    const sandbox = createSandboxContext({ required: true });

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        ...fullElevation,
        fullAccessAvailable: true,
      })?.elevated,
    ).toEqual({
      allowed: false,
      defaultLevel: "off",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "host-policy",
    });
  });

  it("keeps full-access unavailability truth when provided", () => {
    // Runtime-level blocks are authoritative and must not be overwritten by
    // host exec policy that appears permissive.
    const sandbox = createSandboxContext();

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        ...fullElevation,
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      }),
    ).toEqual({
      ...promptInfo,
      elevated: {
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });
  });

  it("marks full access unavailable when exec policy denies execution", () => {
    const sandbox = createSandboxContext();

    expect(buildEmbeddedSandboxInfo(sandbox, fullElevation, { mode: "deny" })?.elevated).toEqual(
      blockedFullAccess,
    );
  });

  it("uses config exec mode when building prompt full-access state", async () => {
    const sandbox = createSandboxContext();
    const execPolicy = await resolveEmbeddedSandboxInfoExecPolicy(
      {
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        },
        agentId: "main",
        sandboxAvailable: true,
      },
      {},
    );

    expect(buildEmbeddedSandboxInfo(sandbox, fullElevation, execPolicy)?.elevated).toEqual(
      blockedFullAccess,
    );
  });

  it("uses elevated host policy when sandbox is active and exec policy is unset", async () => {
    const sandbox = createSandboxContext();
    const execPolicy = await resolveEmbeddedSandboxInfoExecPolicy(
      {
        config: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        agentId: "main",
        sandboxAvailable: true,
      },
      {},
    );

    expect(buildEmbeddedSandboxInfo(sandbox, fullElevation, execPolicy)?.elevated).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: true,
    });
  });

  it("marks full access unavailable when host approval defaults deny execution", () => {
    const sandbox = createSandboxContext();

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        fullElevation,
        { mode: "full", security: "full" },
        { security: "deny" },
      )?.elevated,
    ).toEqual(blockedFullAccess);
  });

  it("marks full access unavailable when host approval floors still require review", () => {
    // Full access is prompt-advertised only when both security level and ask
    // policy allow execution without review.
    const sandbox = createSandboxContext();

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        fullElevation,
        { mode: "full", security: "full", ask: "off" },
        { security: "allowlist", ask: "off" },
      )?.elevated,
    ).toEqual(blockedFullAccess);

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        fullElevation,
        { mode: "full", security: "full", ask: "off" },
        { security: "full", ask: "always" },
      )?.elevated,
    ).toEqual(blockedFullAccess);

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        fullElevation,
        { mode: "full", security: "full", ask: "on-miss" },
        { security: "full", ask: "on-miss" },
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: true,
    });
  });
});
