import type { CachedSnapshot } from "@aotui/runtime";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  OpenClawSnapshotProjector,
  replaceAotuiInjectedMessages,
  stripAotuiInjectedMessages,
} from "./projector.js";
import { OPENCLAW_AOTUI_SYSTEM_INSTRUCTION } from "./system-instruction.js";
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
      desktopState:
        'desktop state with system-open_app, system-close_app, system-dismount_view and `open_app({ app_id: "app_0" })`',
      desktopTimestamp: 1_700_000_000_050,
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

function createKernel() {
  return {
    getSystemToolDefinitions: () => [
      {
        type: "function",
        function: {
          name: "system-open_app",
          description: "Open an installed app",
          parameters: {
            type: "object",
            properties: {
              app_id: { type: "string" },
            },
            required: ["app_id"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system-close_app",
          description: "Close an installed app",
          parameters: {
            type: "object",
            properties: {
              app_id: { type: "string" },
            },
            required: ["app_id"],
            additionalProperties: false,
          },
        },
      },
    ],
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
    const projector = new OpenClawSnapshotProjector(createKernel() as never);
    const messages = projector.projectMessages(createSnapshot(), createRecord()) as Array<
      AgentMessage & { metadata?: Record<string, unknown> }
    >;

    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("user");
    expect(getMessageContent(messages[0] as AgentMessage)).toBe(OPENCLAW_AOTUI_SYSTEM_INSTRUCTION);
    expect(String(getMessageContent(messages[1] as AgentMessage))).toContain("<desktop>");
    expect(String(getMessageContent(messages[1] as AgentMessage))).toContain("desktop-open_app");
    expect(String(getMessageContent(messages[1] as AgentMessage))).toContain("desktop-close_app");
    expect(String(getMessageContent(messages[1] as AgentMessage))).toContain(
      "desktop-dismount_view",
    );
    expect(String(getMessageContent(messages[2] as AgentMessage))).toContain('<view id="fd_0">');
    expect(String(getMessageContent(messages[2] as AgentMessage))).toContain("content");
    expect(String(getMessageContent(messages[1] as AgentMessage))).not.toContain("system-open_app");
    expect(messages[0]?.metadata?.aotui).toMatchObject({
      aotui: true,
      kind: "system_instruction",
      snapshotId: "snap_1",
    });
    expect(messages[1]?.metadata?.aotui).toMatchObject({
      aotui: true,
      kind: "desktop_state",
    });
    expect((messages[1] as { timestamp?: unknown }).timestamp).toBe(1_700_000_000_050);
    expect(messages[2]?.metadata?.aotui).toMatchObject({
      aotui: true,
      kind: "view_state",
      viewId: "fd_0",
    });
  });

  it("projects operation and tool entries into executable bindings", () => {
    const projector = new OpenClawSnapshotProjector(createKernel() as never);
    const bindings = projector.projectToolBindings(createSnapshot(), createRecord());

    expect(bindings.map((binding) => binding.toolName)).toEqual([
      "open_file",
      "lsp_hover",
      "close_terminal",
      "desktop-open_app",
      "desktop-close_app",
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
    expect(bindings[3]?.operation.context.appId).toBe("system");
    expect(bindings[3]?.operation.name).toBe("open_app");
    expect(bindings[3]?.parameters).toMatchObject({
      type: "object",
      properties: {
        app_id: { type: "string" },
      },
      required: ["app_id"],
    });
  });
});

describe("AOTUI injected message replacement", () => {
  it("replaces stale AOTUI messages inside the preamble without polluting the transcript tail", () => {
    const existing = [
      { role: "system", content: "base-system" },
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
        content: "fresh-instruction",
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "system_instruction",
          },
        },
      },
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
      "base-system",
      "persistent-1",
      "persistent-2",
    ]);
    expect(replaceAotuiInjectedMessages(existing, latest).map(getMessageContent)).toEqual([
      "base-system",
      "fresh-instruction",
      "fresh-view",
      "persistent-1",
      "persistent-2",
    ]);
  });

  it("inserts timestamp-sorted dynamic AOTUI messages after tool results when they land inside a tool roundtrip", () => {
    const existing = [
      { role: "system", content: "base-system", timestamp: 1 } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "open_file", input: {} }],
        timestamp: 10,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "done" }],
        timestamp: 20,
      } as unknown as AgentMessage,
      { role: "user", content: "persistent-tail", timestamp: 30 } as AgentMessage,
    ];

    const latest = [
      {
        role: "user",
        content: "fresh-instruction",
        timestamp: 5,
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "system_instruction",
          },
        },
      },
      {
        role: "user",
        content: '<view id="fd_0">fresh-view</view>',
        timestamp: 15,
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

    expect(replaceAotuiInjectedMessages(existing, latest).map(getMessageContent)).toEqual([
      "base-system",
      "fresh-instruction",
      [{ type: "toolUse", id: "call_1", name: "open_file", input: {} }],
      [{ type: "text", text: "done" }],
      '<view id="fd_0">fresh-view</view>',
      "persistent-tail",
    ]);
  });

  it("sorts desktop and view messages by timestamp before inserting them", () => {
    const existing = [
      { role: "system", content: "base-system", timestamp: 1 } as unknown as AgentMessage,
      { role: "user", content: "older-user", timestamp: 100 } as AgentMessage,
      {
        role: "assistant",
        content: "assistant-reply",
        timestamp: 200,
      } as unknown as AgentMessage,
      { role: "user", content: "latest-user", timestamp: 300 } as AgentMessage,
    ];

    const latest = [
      {
        role: "user",
        content: "fresh-instruction",
        timestamp: 1,
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "system_instruction",
          },
        },
      },
      {
        role: "user",
        content: "<desktop>desktop-state</desktop>",
        timestamp: 350,
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "desktop_state",
          },
        },
      },
      {
        role: "user",
        content: '<view id="term_console">view-state</view>',
        timestamp: 150,
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "view_state",
            viewId: "term_console",
          },
        },
      },
    ] as unknown as AgentMessage[];

    expect(replaceAotuiInjectedMessages(existing, latest).map(getMessageContent)).toEqual([
      "base-system",
      "fresh-instruction",
      "older-user",
      '<view id="term_console">view-state</view>',
      "assistant-reply",
      "latest-user",
      "<desktop>desktop-state</desktop>",
    ]);
  });

  it("preserves previous timestamps for unchanged desktop and view messages", () => {
    const existing = [
      { role: "system", content: "base-system", timestamp: 1 } as unknown as AgentMessage,
      {
        role: "user",
        content: "<desktop>\nstate\n</desktop>",
        timestamp: 5,
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_old",
            kind: "desktop_state",
          },
        },
      } as unknown as AgentMessage,
      { role: "user", content: "real-user", timestamp: 20 } as AgentMessage,
    ];

    const latest = [
      {
        role: "user",
        content: "fresh-instruction",
        timestamp: 100,
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "system_instruction",
          },
        },
      },
      {
        role: "user",
        content: "<desktop>\nstate\n</desktop>",
        timestamp: 100,
        metadata: {
          aotui: {
            aotui: true,
            desktopKey: "agent:main:discord:channel:dev",
            snapshotId: "snap_new",
            kind: "desktop_state",
          },
        },
      },
    ] as unknown as AgentMessage[];

    const replaced = replaceAotuiInjectedMessages(existing, latest) as Array<{
      content?: unknown;
      timestamp?: unknown;
    }>;
    expect(replaced.map((message) => message.content)).toEqual([
      "base-system",
      "fresh-instruction",
      "<desktop>\nstate\n</desktop>",
      "real-user",
    ]);
    expect(replaced[1]?.timestamp).toBe(100);
    expect(replaced[2]?.timestamp).toBe(5);
  });
});
