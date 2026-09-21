import fs from "node:fs/promises";
import { afterEach, beforeEach, vi } from "vitest";
import type { ChromeMcpSession } from "./chrome-mcp-contracts.js";
import { resetChromeMcpSessionsForTest } from "./chrome-mcp-session.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";

export type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};
export type SessionPage = { id: number; url: string; selected?: boolean };

export function createPageSession(params: {
  pages: SessionPage[];
  pid: number;
  onTool?: (call: ToolCall) => unknown;
}): ChromeMcpSession {
  const callTool = vi.fn(async (call: ToolCall) => {
    const custom = await params.onTool?.(call);
    if (custom !== undefined) {
      return custom;
    }
    if (call.name === "list_pages") {
      return {
        structuredContent: {
          pages: params.pages.map(({ id, url, selected }) => ({ id, url, selected })),
        },
      };
    }
    if (call.name === "evaluate_script") {
      return { content: [{ type: "text", text: "```json\nnull\n```" }] };
    }
    throw new Error(`unexpected tool ${call.name}`);
  });
  const client = {
    callTool,
    listTools: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
  };
  return {
    client,
    transport: { pid: params.pid },
    closeTransport: () => client.close(),
    ready: Promise.resolve(),
  } as unknown as ChromeMcpSession;
}

export function installChromeMcpSessionTestHooks() {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}

export const FAKE_TARGET_1 = "chrome-mcp:000000000001:1";
export const FAKE_TARGET_2 = "chrome-mcp:000000000001:2";
const FAKE_TARGET_3 = "chrome-mcp:000000000001:3";
export const FAKE_REF = "mcp-ref:000000000001:1";

export function createFakeSession(screenshotError?: string): ChromeMcpSession {
  let currentUrl =
    "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session";
  let createdPageOpen = false;
  const readUrlArg = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value : fallback;
  const callTool = vi.fn(async ({ name, arguments: args }: ToolCall) => {
    if (name === "list_pages") {
      const pageLines = [
        "## Pages",
        `1: ${currentUrl} [selected]`,
        "2: https://github.com/openclaw/openclaw/pull/45318",
      ];
      if (createdPageOpen) {
        pageLines.push(`3: ${currentUrl}`);
      }
      return {
        content: [
          {
            type: "text",
            text: pageLines.join("\n"),
          },
        ],
      };
    }
    if (name === "new_page") {
      currentUrl = readUrlArg(args?.url, "about:blank");
      createdPageOpen = true;
      return {
        content: [
          {
            type: "text",
            text: [
              "## Pages",
              "1: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
              "2: https://github.com/openclaw/openclaw/pull/45318",
              `3: ${currentUrl} [selected]`,
            ].join("\n"),
          },
        ],
      };
    }
    if (name === "navigate_page") {
      currentUrl = readUrlArg(args?.url, currentUrl);
      return { content: [{ type: "text", text: "navigated" }] };
    }
    if (name === "evaluate_script") {
      return {
        content: [
          {
            type: "text",
            text: "```json\n123\n```",
          },
        ],
      };
    }
    if (name === "take_screenshot") {
      const filePath = typeof args?.filePath === "string" ? args.filePath : undefined;
      const format = args?.format === "jpeg" ? "jpeg" : "png";
      if (!filePath) {
        throw new Error("missing filePath");
      }
      await fs.writeFile(`${filePath}.${format}`, Buffer.from(`screenshot:${format}`));
      if (screenshotError) {
        throw new Error(screenshotError);
      }
      return { content: [{ type: "text", text: `Saved screenshot to ${filePath}.${format}.` }] };
    }
    throw new Error(`unexpected tool ${name}`);
  });

  const client = {
    callTool,
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
  };
  return {
    client,
    transport: {
      pid: 123,
    },
    closeTransport: () => client.close(),
    ready: Promise.resolve(),
    // Legacy cases exercise unrelated call plumbing. Seed one real-shaped
    // process-scoped routing generation so they stay terse.
    routing: {
      sessionNonce: "000000000001",
      withOperationLock: async <T>(operation: () => Promise<T>) => await operation(),
      targetIdByPageId: new Map([
        [1, FAKE_TARGET_1],
        [2, FAKE_TARGET_2],
        [3, FAKE_TARGET_3],
      ]),
      nextTargetHandleId: 4,
      snapshotsByTarget: new Map([
        [FAKE_TARGET_1, { documentUid: "root-1", refs: new Map([[FAKE_REF, { uid: "btn-1" }]]) }],
      ]),
      nextSnapshotRefId: 2,
    },
  } as unknown as ChromeMcpSession;
}

export function snapshotWithControls(...children: ChromeMcpSnapshotNode[]): ChromeMcpSnapshotNode {
  return { id: "root", role: "RootWebArea", children };
}
