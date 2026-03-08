import type { CachedSnapshot } from "@aotui/runtime";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  OpenClawSnapshotProjector,
  replaceAotuiInjectedMessages,
  stripAotuiInjectedMessages,
} from "./projector.js";
import type { DesktopRecord } from "./types.js";

function getMessageContent(message: AgentMessage): unknown {
  return (message as { content?: unknown }).content;
}

function createSnapshot(): CachedSnapshot {
  return {
    id: "snap_1" as CachedSnapshot["id"],
    markup: "<desktop />",
    createdAt: 1_700_000_000_000,
    refCount: 1,
    indexMap: {
      open_file: {
        type: "operation",
        appId: "app_1",
        operation: {
          id: "open_file",
          displayName: "Open file",
          params: [{ name: "path", type: "string", required: true }],
        },
      },
      "tool:lsp_hover": {
        description: "Hover current symbol",
        appId: "app_1",
        viewType: "FileDetail",
        toolName: "lsp_hover",
        params: [{ name: "line", type: "number", required: true }],
      },
      "tool:close_terminal": {
        description: "Close terminal",
        appId: "terminal-app",
        viewType: "Terminal",
        toolName: "close_terminal",
        params: [{ name: "terminal", type: "reference", required: true }],
      },
    },
    structured: {
      systemInstruction: "follow the desktop",
      desktopState: "desktop state",
      appStates: [],
      viewStates: [
        {
          appId: "app_1",
          appName: "system_ide",
          viewId: "fd_0",
          viewType: "FileDetail",
          viewName: "File Detail",
          markup: '<view id="fd_0">content</view>',
          timestamp: 1_700_000_000_100,
        },
      ],
    },
  };
}

function createRecord(): DesktopRecord {
  return {
    desktopKey: "agent:main:discord:channel:dev",
    desktopId: "agent:main:discord:channel:dev" as DesktopRecord["desktopId"],
    sessionKey: "agent:main:discord:channel:dev",
    agentId: "main",
    createdAt: 1_700_000_000_000,
    lastActiveAt: 1_700_000_000_000,
    status: "active",
  };
}

describe("OpenClawSnapshotProjector", () => {
  it("projects structured messages with AOTUI metadata", () => {
    const projector = new OpenClawSnapshotProjector();
    const messages = projector.projectMessages(createSnapshot(), createRecord()) as Array<
      AgentMessage & { metadata?: Record<string, unknown> }
    >;

    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("system");
    expect(messages[0]?.metadata?.aotui).toMatchObject({
      aotui: true,
      kind: "system_instruction",
      snapshotId: "snap_1",
    });
    expect(messages[2]?.metadata?.aotui).toMatchObject({
      aotui: true,
      kind: "view_state",
      viewId: "fd_0",
    });
  });

  it("projects operation and tool entries into executable bindings", () => {
    const projector = new OpenClawSnapshotProjector();
    const bindings = projector.projectToolBindings(createSnapshot(), createRecord());

    expect(bindings.map((binding) => binding.toolName)).toEqual([
      "open_file",
      "lsp_hover",
      "close_terminal",
    ]);
    expect(bindings[0]?.parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    });
    expect(bindings[1]?.operation.context.viewId).toBe("FileDetail");
    expect(bindings[1]?.operation.name).toBe("lsp_hover");
    expect(bindings[2]?.parameters).toMatchObject({
      type: "object",
      properties: {
        terminal: { type: "string" },
      },
      required: ["terminal"],
    });
  });
});

describe("AOTUI injected message replacement", () => {
  it("removes old injected messages before appending latest view state", () => {
    const existing = [
      { role: "user", content: "persistent-1" },
      {
        role: "user",
        content: "stale-view",
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_old",
            kind: "view_state",
            viewId: "fd_0",
          },
        },
      },
      { role: "assistant", content: "persistent-2" },
    ] as unknown as AgentMessage[];

    const latest = [
      {
        role: "user",
        content: "fresh-view",
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "view_state",
            viewId: "fd_0",
          },
        },
      },
    ] as unknown as AgentMessage[];

    expect(stripAotuiInjectedMessages(existing).map(getMessageContent)).toEqual([
      "persistent-1",
      "persistent-2",
    ]);
    expect(replaceAotuiInjectedMessages(existing, latest).map(getMessageContent)).toEqual([
      "persistent-1",
      "persistent-2",
      "fresh-view",
    ]);
  });
});
