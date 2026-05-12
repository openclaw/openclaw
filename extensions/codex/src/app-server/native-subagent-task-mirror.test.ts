import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexNativeSubagentRunId,
  CodexNativeSubagentTaskMirror,
  resetCodexNativeTaskMirrorRuntimeForTests,
  resolveCodexNativeTaskRuntimeForTests,
  type TaskLifecycleRuntime,
} from "./native-subagent-task-mirror.js";

const tempDirs: string[] = [];

function createRuntime() {
  return {
    createRunningTaskRun: vi.fn(),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn(() => []),
  } as unknown as TaskLifecycleRuntime;
}

function makeOpenClawRuntimeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-runtime-"));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf-8",
  );
  return root;
}

function writeSourceRuntime(root: string) {
  const runtimePath = path.join(root, "src", "plugin-sdk", "codex-native-task-runtime.ts");
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, "export {};\n", "utf-8");
  return runtimePath;
}

function sourceMirrorModuleUrl(root: string) {
  return pathToFileURL(
    path.join(root, "extensions", "codex", "src", "app-server", "native-subagent-task-mirror.ts"),
  ).href;
}

afterEach(() => {
  resetCodexNativeTaskMirrorRuntimeForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CodexNativeSubagentTaskMirror", () => {
  it("resolves the private runtime from OpenClaw source when package subpath resolution is unavailable", () => {
    const root = makeOpenClawRuntimeRoot();
    const sourceRuntimePath = writeSourceRuntime(root);
    const runtime = createRuntime();
    const requireModule = vi.fn((specifier: string) => {
      throw new Error(`missing ${specifier}`);
    });
    const loadSourceRuntime = vi.fn((specifier: string) => {
      expect(specifier).toBe(sourceRuntimePath);
      return runtime;
    });
    const createJiti = vi.fn(() => loadSourceRuntime);

    const resolved = resolveCodexNativeTaskRuntimeForTests({
      moduleUrl: sourceMirrorModuleUrl(root),
      argv1: "",
      requireModule,
      createJiti,
    });

    expect(resolved).toBe(runtime);
    expect(requireModule).toHaveBeenCalledWith("openclaw/plugin-sdk/codex-native-task-runtime");
    expect(requireModule).toHaveBeenCalledWith(sourceRuntimePath);
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(loadSourceRuntime).toHaveBeenCalledWith(sourceRuntimePath);
  });

  it("uses a no-op runtime when the private runtime helper is absent", () => {
    const root = makeOpenClawRuntimeRoot();
    const requireModule = vi.fn((specifier: string) => {
      throw new Error(`missing ${specifier}`);
    });
    const createJiti = vi.fn();

    const resolved = resolveCodexNativeTaskRuntimeForTests({
      moduleUrl: sourceMirrorModuleUrl(root),
      argv1: "",
      requireModule,
      createJiti,
    });

    expect(resolved.createRunningTaskRun({})).toBeUndefined();
    expect(resolved.recordTaskRunProgressByRunId({})).toBeUndefined();
    expect(resolved.finalizeTaskRunByRunId({})).toBeUndefined();
    expect(createJiti).not.toHaveBeenCalled();
  });

  it("creates a silent task-registry task for a native Codex subagent thread", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        agentId: "main",
        now: () => 20_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          sessionId: "session-tree",
          preview: "write the Madrid wine script",
          createdAt: 10,
          status: { type: "active", activeFlags: [] },
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_nickname: "Poincare",
                agent_role: "worker",
              },
            },
          },
        },
      },
    });

    expect(runtime.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "subagent",
        taskKind: "codex-native",
        sourceId: "codex-thread:child-thread",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        agentId: "main",
        runId: "codex-thread:child-thread",
        label: "Poincare",
        task: "write the Madrid wine script",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        startedAt: 10_000,
        progressSummary: "Codex native subagent started.",
      }),
    );
    expect(vi.mocked(runtime.createRunningTaskRun).mock.calls.at(0)?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        runtime: "subagent",
        progressSummary: "Codex native subagent is active.",
      }),
    );
  });

  it("ignores subagent threads spawned by a different parent thread", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
      },
      runtime,
    );

    mirror.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "other-child",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "other-parent",
                depth: 1,
              },
            },
          },
        },
      },
    });

    expect(runtime.createRunningTaskRun).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("deduplicates repeated thread-started notifications for the same child thread", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
      },
      runtime,
    );
    const notification = {
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
              },
            },
          },
        },
      },
    } as const;

    mirror.handleNotification(notification);
    mirror.handleNotification(notification);

    expect(runtime.createRunningTaskRun).toHaveBeenCalledTimes(1);
  });

  it("maps Codex thread status changes onto the mirrored task run", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 30_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });
    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "failed-child",
        status: { type: "systemError" },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runId: codexNativeSubagentRunId("child-thread"),
        runtime: "subagent",
        status: "succeeded",
        terminalSummary: "Codex native subagent finished.",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: codexNativeSubagentRunId("failed-child"),
        runtime: "subagent",
        status: "failed",
        terminalSummary: "Codex native subagent failed.",
      }),
    );
  });

  it("creates and updates tasks from Codex collab agent item state", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 40_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "write the proof file",
          agentsStates: {
            "child-thread": {
              status: "pendingInit",
              message: null,
            },
          },
        },
      },
    });
    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          senderThreadId: "parent-thread",
          receiverThreadIds: [],
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "done",
            },
          },
        },
      },
    });

    expect(runtime.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "subagent",
        taskKind: "codex-native",
        sourceId: "codex-thread:child-thread",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "codex-thread:child-thread",
        label: "Codex subagent",
        task: "write the proof file",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      }),
    );
    expect(vi.mocked(runtime.createRunningTaskRun).mock.calls.at(0)?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        runtime: "subagent",
        progressSummary: "Codex native subagent is initializing.",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        runtime: "subagent",
        status: "succeeded",
        terminalSummary: "done",
      }),
    );
  });

  it("preserves a completed collab agent message when the thread later goes idle", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 50_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "write the proof file",
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "No user task is specified.",
            },
          },
        },
      },
    });
    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        status: "succeeded",
        terminalSummary: "No user task is specified.",
      }),
    );
  });

  it("normalizes collab agent status spelling from alternate event surfaces", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 60_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": {
              status: "pending_init",
              message: null,
            },
          },
        },
      },
    });
    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          senderThreadId: "parent-thread",
          agentsStates: {
            "child-thread": {
              status: "success",
              message: "done",
            },
          },
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        progressSummary: "Codex native subagent is initializing.",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        status: "succeeded",
        terminalSummary: "done",
      }),
    );
  });
});
