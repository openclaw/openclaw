import { describe, expect, it } from "vitest";
import type { PreparedAgentRun } from "./runtime-backend.js";
import {
  buildNodePermissionExecArgv,
  createAgentWorkerPermissionProfile,
  type AgentWorkerPermissionProfile,
} from "./runtime-worker-permissions.js";

function createPreparedRun(overrides: Partial<PreparedAgentRun> = {}): PreparedAgentRun {
  return {
    runtimeId: "test",
    runId: "run-permissions",
    agentId: "main",
    sessionId: "session-permissions",
    sessionKey: "agent:main:main",
    sessionFile: "sqlite-transcript://main/session-permissions.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    filesystemMode: "vfs-scratch",
    deliveryPolicy: { emitToolResult: false, emitToolOutput: false },
    ...overrides,
  };
}

describe("agent worker permission profile", () => {
  it("keeps permission args disabled by default", () => {
    const profile = createAgentWorkerPermissionProfile(createPreparedRun(), {
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      runtimeReadRoots: ["/app/runtime"],
    });

    expect(profile.mode).toBe("off");
    expect(buildNodePermissionExecArgv(profile)).toEqual([]);
  });

  it("grants runtime, state, and workspace paths for disk-backed modes", () => {
    const profile = createAgentWorkerPermissionProfile(createPreparedRun(), {
      mode: "enforce",
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      runtimeReadRoots: ["/app/runtime"],
    });

    expect(profile).toMatchObject({
      mode: "enforce",
      fsRead: ["/app/runtime", "/tmp/openclaw-state/state", "/tmp/workspace"],
      fsWrite: ["/tmp/openclaw-state/state", "/tmp/workspace"],
      allowWorker: false,
      allowChildProcess: false,
      allowAddons: false,
      allowWasi: false,
    });
  });

  it("does not grant workspace access for vfs-only runs", () => {
    const profile = createAgentWorkerPermissionProfile(
      createPreparedRun({ filesystemMode: "vfs-only" }),
      {
        mode: "audit",
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
        runtimeReadRoots: ["/app/runtime"],
      },
    );

    expect(profile.fsRead).toEqual(["/app/runtime", "/tmp/openclaw-state/state"]);
    expect(profile.fsWrite).toEqual(["/tmp/openclaw-state/state"]);
    expect(buildNodePermissionExecArgv(profile)).toEqual([
      "--permission-audit",
      "--allow-fs-read=/app/runtime",
      "--allow-fs-read=/tmp/openclaw-state/state",
      "--allow-fs-write=/tmp/openclaw-state/state",
    ]);
  });

  it("builds explicit allow flags only when requested", () => {
    const profile: AgentWorkerPermissionProfile = {
      mode: "enforce",
      fsRead: ["/runtime"],
      fsWrite: ["/state"],
      allowWorker: true,
      allowChildProcess: true,
      allowAddons: false,
      allowWasi: true,
    };

    expect(buildNodePermissionExecArgv(profile)).toEqual([
      "--permission",
      "--allow-fs-read=/runtime",
      "--allow-fs-write=/state",
      "--allow-worker",
      "--allow-child-process",
      "--allow-wasi",
    ]);
  });
});
