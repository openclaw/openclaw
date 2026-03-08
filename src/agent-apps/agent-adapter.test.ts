import type { CachedSnapshot, OperationResult } from "@aotui/runtime";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawAgentAdapter } from "./agent-adapter.js";
import type { AotuiSnapshotProjector, DesktopRecord, OpenClawAgentHandle } from "./types.js";

function createDesktopRecord(): DesktopRecord {
  return {
    desktopKey: "agent:main:discord:channel:dev",
    desktopId: "agent:main:discord:channel:dev" as DesktopRecord["desktopId"],
    sessionKey: "agent:main:discord:channel:dev",
    sessionId: "session_1",
    agentId: "main",
    createdAt: 1_700_000_000_000,
    lastActiveAt: 1_700_000_000_000,
    status: "active",
  };
}

function createSnapshot(id: string): CachedSnapshot {
  return {
    id: id as CachedSnapshot["id"],
    markup: `<desktop id="${id}" />`,
    createdAt: 1_700_000_000_000,
    refCount: 1,
    indexMap: {},
  };
}

function createInjectedMessage(text: string, snapshotId: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: 1_700_000_000_000,
    metadata: {
      aotui: {
        aotui: true,
        desktopKey: "agent:main:discord:channel:dev",
        snapshotId,
        kind: "view_state",
        viewId: "view_1",
      },
    },
  } as unknown as AgentMessage;
}

describe("OpenClawAgentAdapter", () => {
  let desktopRecord: DesktopRecord;
  let desktopManager: {
    ensureDesktop: ReturnType<typeof vi.fn>;
    touchDesktop: ReturnType<typeof vi.fn>;
  };
  let kernel: {
    acquireSnapshot: ReturnType<typeof vi.fn>;
    releaseSnapshot: ReturnType<typeof vi.fn>;
    acquireLock: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };
  let agent: OpenClawAgentHandle;
  let baseTool: AgentTool;

  beforeEach(() => {
    desktopRecord = createDesktopRecord();
    desktopManager = {
      ensureDesktop: vi.fn(async () => desktopRecord),
      touchDesktop: vi.fn(async () => undefined),
    };
    kernel = {
      acquireSnapshot: vi.fn(),
      releaseSnapshot: vi.fn(),
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
      execute: vi.fn(),
    };
    baseTool = {
      name: "read_file",
      label: "read_file",
      execute: vi.fn(),
    } as unknown as AgentTool;
    agent = {
      state: { tools: [baseTool] },
      setTools: vi.fn(),
    };
  });

  it("routes projected tools through Kernel.execute with the desktop lock held", async () => {
    const snapshot = createSnapshot("snap_tools");
    const projector: AotuiSnapshotProjector = {
      projectMessages: vi.fn(() => []),
      projectToolBindings: vi.fn(() => [
        {
          toolName: "open_file",
          description: "Open file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          operation: {
            context: {
              appId: "app_1" as never,
              snapshotId: "latest" as never,
              viewId: "view_1" as never,
            },
            name: "open_file" as never,
            args: {},
          },
        },
      ]),
    };

    const opResult: OperationResult = {
      success: true,
      data: { opened: true, path: "README.md" },
    } as OperationResult;
    kernel.acquireSnapshot.mockResolvedValue(snapshot);
    kernel.execute.mockResolvedValue(opResult);

    const adapter = new OpenClawAgentAdapter({
      sessionKey: desktopRecord.sessionKey,
      sessionId: desktopRecord.sessionId,
      agentId: desktopRecord.agentId,
      ownerId: "run_1",
      kernel: kernel as never,
      desktopManager: desktopManager as never,
      agent,
      baseTools: [baseTool],
      projector,
    });

    await adapter.install();

    const installedTools = (agent.setTools as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as AgentTool[];
    expect(installedTools).toHaveLength(2);
    expect(installedTools[0]?.name).toBe("read_file");
    expect(installedTools[1]?.name).toBe("open_file");

    const openFileTool = installedTools[1];
    expect(openFileTool).toBeDefined();
    const result = await openFileTool.execute("tool_1", { path: "README.md" });

    expect(kernel.acquireLock).toHaveBeenCalledWith(desktopRecord.desktopId, "run_1");
    expect(kernel.execute).toHaveBeenCalledWith(
      desktopRecord.desktopId,
      {
        context: {
          appId: "app_1",
          snapshotId: "latest",
          viewId: "view_1",
        },
        name: "open_file",
        args: { path: "README.md" },
      },
      "run_1",
    );
    expect(kernel.releaseLock).toHaveBeenCalledWith(desktopRecord.desktopId, "run_1");
    expect(result).toMatchObject({
      details: {
        toolCallId: "tool_1",
        toolName: "open_file",
        result: { opened: true, path: "README.md" },
      },
      content: [{ type: "text", text: expect.stringContaining("README.md") }],
    });
  });

  it("returns a locked error-shaped tool result when Kernel.execute fails", async () => {
    const snapshot = createSnapshot("snap_tools_error");
    const projector: AotuiSnapshotProjector = {
      projectMessages: vi.fn(() => []),
      projectToolBindings: vi.fn(() => [
        {
          toolName: "open_file",
          description: "Open file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          operation: {
            context: {
              appId: "app_1" as never,
              snapshotId: "latest" as never,
            },
            name: "open_file" as never,
            args: {},
          },
        },
      ]),
    };

    kernel.acquireSnapshot.mockResolvedValue(snapshot);
    kernel.execute.mockResolvedValue({
      success: false,
      error: {
        code: "E_OPEN_FAILED",
        message: "failed to open file",
        details: { path: "missing.md" },
      },
    } as OperationResult);

    const adapter = new OpenClawAgentAdapter({
      sessionKey: desktopRecord.sessionKey,
      sessionId: desktopRecord.sessionId,
      agentId: desktopRecord.agentId,
      ownerId: "run_1",
      kernel: kernel as never,
      desktopManager: desktopManager as never,
      agent,
      baseTools: [baseTool],
      projector,
    });

    await adapter.install();

    const installedTools = (agent.setTools as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as AgentTool[];
    const openFileTool = installedTools[1];
    expect(openFileTool).toBeDefined();
    const result = await openFileTool.execute("tool_err_1", { path: "missing.md" });

    expect(kernel.acquireLock).toHaveBeenCalledWith(desktopRecord.desktopId, "run_1");
    expect(kernel.releaseLock).toHaveBeenCalledWith(desktopRecord.desktopId, "run_1");
    expect(result).toMatchObject({
      details: {
        toolCallId: "tool_err_1",
        toolName: "open_file",
        error: {
          code: "E_OPEN_FAILED",
          message: "failed to open file",
          details: { path: "missing.md" },
        },
      },
      content: [{ type: "text", text: expect.stringContaining("E_OPEN_FAILED") }],
    });
  });

  it("returns E_TOOL_NOT_FOUND without touching Kernel.execute when the binding is missing", async () => {
    const snapshot = createSnapshot("snap_missing_tool");
    const projector: AotuiSnapshotProjector = {
      projectMessages: vi.fn(() => []),
      projectToolBindings: vi.fn(() => []),
    };

    kernel.acquireSnapshot.mockResolvedValue(snapshot);

    const adapter = new OpenClawAgentAdapter({
      sessionKey: desktopRecord.sessionKey,
      sessionId: desktopRecord.sessionId,
      agentId: desktopRecord.agentId,
      ownerId: "run_missing",
      kernel: kernel as never,
      desktopManager: desktopManager as never,
      agent,
      baseTools: [baseTool],
      projector,
    });

    await adapter.install();

    const result = await adapter.routeToolCall(
      "missing_tool",
      { path: "missing.md" },
      "tool_missing_1",
    );

    expect(result).toEqual({
      toolCallId: "tool_missing_1",
      toolName: "missing_tool",
      error: {
        code: "E_TOOL_NOT_FOUND",
        message: "Unknown AOTUI tool: missing_tool",
      },
    });
    expect(kernel.acquireLock).not.toHaveBeenCalled();
    expect(kernel.execute).not.toHaveBeenCalled();
    expect(kernel.releaseLock).not.toHaveBeenCalled();
  });

  it("refreshes tools and replaces stale injected view messages with the latest snapshot state", async () => {
    const snapshots = [createSnapshot("snap_install"), createSnapshot("snap_refresh")];
    kernel.acquireSnapshot.mockImplementation(async () => snapshots.shift());
    const projector: AotuiSnapshotProjector = {
      projectMessages: vi.fn((snapshot) => {
        if (snapshot.id === "snap_refresh") {
          return [createInjectedMessage("fresh-view", "snap_refresh")];
        }
        return [createInjectedMessage(`message-${String(snapshot.id)}`, String(snapshot.id))];
      }),
      projectToolBindings: vi.fn((snapshot) => {
        if (snapshot.id === "snap_install") {
          return [
            {
              toolName: "tool_v1",
              description: "Tool v1",
              parameters: { type: "object", properties: {} },
              operation: {
                context: {
                  appId: "app_1" as never,
                  snapshotId: "latest" as never,
                },
                name: "tool_v1" as never,
                args: {},
              },
            },
          ];
        }

        return [
          {
            toolName: "tool_v2",
            description: "Tool v2",
            parameters: { type: "object", properties: {} },
            operation: {
              context: {
                appId: "app_2" as never,
                snapshotId: "latest" as never,
              },
              name: "tool_v2" as never,
              args: {},
            },
          },
        ];
      }),
    };

    const originalTransformContext = vi.fn(async (messages: AgentMessage[]) => [
      ...messages,
      { role: "user", content: "persistent-tail", timestamp: 1_700_000_000_001 } as AgentMessage,
    ]);
    agent.transformContext = originalTransformContext;

    const adapter = new OpenClawAgentAdapter({
      sessionKey: desktopRecord.sessionKey,
      sessionId: desktopRecord.sessionId,
      agentId: desktopRecord.agentId,
      ownerId: "run_2",
      kernel: kernel as never,
      desktopManager: desktopManager as never,
      agent,
      baseTools: [baseTool],
      projector,
    });

    await adapter.install();

    const transformed = await agent.transformContext?.(
      [
        { role: "user", content: "persistent-input", timestamp: 1_700_000_000_000 } as AgentMessage,
        createInjectedMessage("stale-view", "snap_old"),
      ],
      undefined,
    );

    const setToolsCalls = (agent.setTools as ReturnType<typeof vi.fn>).mock.calls;
    expect(setToolsCalls).toHaveLength(2);
    const firstTools = setToolsCalls[0]?.[0] as AgentTool[] | undefined;
    const secondTools = setToolsCalls[1]?.[0] as AgentTool[] | undefined;
    if (!firstTools || !secondTools) {
      throw new Error("expected projected tools to be installed twice");
    }
    expect(firstTools.map((tool) => tool.name)).toEqual(["read_file", "tool_v1"]);
    expect(secondTools.map((tool) => tool.name)).toEqual(["read_file", "tool_v2"]);

    const contents = (transformed ?? []).map(
      (message) => (message as { content?: unknown }).content,
    );
    expect(contents).toEqual(["persistent-input", "fresh-view", "persistent-tail"]);
    expect(contents).not.toContain("stale-view");
    expect(originalTransformContext).toHaveBeenCalledTimes(1);
    expect(kernel.releaseSnapshot).toHaveBeenCalledTimes(2);
    expect(
      (projector.projectMessages as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]?.id),
    ).toEqual(["snap_install", "snap_refresh"]);
    expect(
      (projector.projectToolBindings as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0]?.id,
      ),
    ).toEqual(["snap_install", "snap_refresh"]);
  });
});
