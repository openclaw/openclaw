import { describe, expect, it } from "vitest";
import type { ResolvedCliBackend } from "../cli-backends.js";
import { resolveCliMcpToolOwnership } from "./prepare-mcp.js";
import type { RunCliAgentParams } from "./types.js";

function makeRun(overrides: Partial<RunCliAgentParams> = {}): RunCliAgentParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:dashboard:session-1",
    sessionFile: "fixture.jsonl",
    workspaceDir: "/workspace",
    prompt: "hello",
    provider: "custom-cli",
    model: "test-model",
    runId: "run-1",
    timeoutMs: 1000,
    ...overrides,
  };
}

function makeBackend(overrides: Partial<ResolvedCliBackend> = {}): ResolvedCliBackend {
  return {
    id: "custom-cli",
    bundleMcp: true,
    nativeToolMode: "selectable",
    toolAvailabilityEnforcement: "prepare-execution",
    prepareExecution: async () => ({ toolAvailabilityEnforced: true }),
    hostOwnedTools: ["Read", "write", "edit", "apply_patch", "exec", "process"],
    config: {
      command: "custom-cli",
      output: "jsonl",
      input: "stdin",
    },
    ...overrides,
  };
}

describe("resolveCliMcpToolOwnership", () => {
  it("returns normalized hostOwnedTools for prepare-execution backends with prepareExecution", () => {
    const ownership = resolveCliMcpToolOwnership(makeRun(), {
      backend: makeBackend(),
      enabled: true,
      nodePlacement: false,
      skipPreparation: false,
    });
    expect(ownership.hostOwnedTools).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
    ]);
    expect(ownership.bridgeConfiguredMcp).toBe(false);
  });

  it("returns normalized hostOwnedTools for execution-args backends with resolveExecutionArgs", () => {
    const ownership = resolveCliMcpToolOwnership(makeRun(), {
      backend: makeBackend({
        toolAvailabilityEnforcement: "execution-args",
        prepareExecution: undefined,
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
        hostOwnedTools: ["exec", "process"],
      }),
      enabled: true,
      nodePlacement: false,
      skipPreparation: false,
    });
    expect(ownership.hostOwnedTools).toEqual(["exec", "process"]);
  });

  it("returns undefined hostOwnedTools when prepare-execution backend lacks prepareExecution", () => {
    const ownership = resolveCliMcpToolOwnership(makeRun(), {
      backend: makeBackend({
        toolAvailabilityEnforcement: "prepare-execution",
        prepareExecution: undefined,
      }),
      enabled: true,
      nodePlacement: false,
      skipPreparation: false,
    });
    expect(ownership.hostOwnedTools).toBeUndefined();
  });

  it("returns undefined hostOwnedTools when execution-args backend lacks resolveExecutionArgs", () => {
    const ownership = resolveCliMcpToolOwnership(makeRun(), {
      backend: makeBackend({
        toolAvailabilityEnforcement: "execution-args",
        prepareExecution: undefined,
        resolveExecutionArgs: undefined,
      }),
      enabled: true,
      nodePlacement: false,
      skipPreparation: false,
    });
    expect(ownership.hostOwnedTools).toBeUndefined();
  });

  it("drops blank entries, deduplicates aliases, and treats empty hostOwnedTools as undefined", () => {
    expect(
      resolveCliMcpToolOwnership(makeRun(), {
        backend: makeBackend({ hostOwnedTools: [] }),
        enabled: true,
        nodePlacement: false,
        skipPreparation: false,
      }).hostOwnedTools,
    ).toBeUndefined();
    expect(
      resolveCliMcpToolOwnership(makeRun(), {
        backend: makeBackend({ hostOwnedTools: ["", "   "] }),
        enabled: true,
        nodePlacement: false,
        skipPreparation: false,
      }).hostOwnedTools,
    ).toBeUndefined();
    expect(
      resolveCliMcpToolOwnership(makeRun(), {
        backend: makeBackend({ hostOwnedTools: ["  Exec ", "apply-patch", "apply_patch", ""] }),
        enabled: true,
        nodePlacement: false,
        skipPreparation: false,
      }).hostOwnedTools,
    ).toEqual(["exec", "apply_patch"]);
  });

  it("returns undefined hostOwnedTools for explicit cliToolAvailability, node exec, or disabled MCP", () => {
    const backend = makeBackend();
    expect(
      resolveCliMcpToolOwnership(
        makeRun({ cliToolAvailability: { native: [], openClaw: ["session_status"] } }),
        { backend, enabled: true, nodePlacement: false, skipPreparation: false },
      ).hostOwnedTools,
    ).toBeUndefined();
    expect(
      resolveCliMcpToolOwnership(makeRun({ execOverrides: { host: "node" } }), {
        backend,
        enabled: true,
        nodePlacement: false,
        skipPreparation: false,
      }).hostOwnedTools,
    ).toBeUndefined();
    expect(
      resolveCliMcpToolOwnership(makeRun(), {
        backend,
        enabled: false,
        nodePlacement: false,
        skipPreparation: false,
      }).hostOwnedTools,
    ).toBeUndefined();
  });
});
