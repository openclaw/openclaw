import fs from "node:fs/promises";
import { afterEach, beforeEach, vi } from "vitest";
import * as chromeMcpConnect from "./chrome-mcp-connect.js";
import type {
  ChromeMcpSession,
  ChromeMcpToolResult,
  NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import { closeChromeMcpSession } from "./chrome-mcp-session.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";

const { resetChromeMcpProcessMocks } = await vi.hoisted(
  () => import("./chrome-mcp-process.test-support.js"),
);

export type ChromeMcpSessionFactory = (
  profileName: string,
  options?: NormalizedChromeMcpProfileOptions,
) => ChromeMcpSession;

const ownedProfiles = new Set<string>();

export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  if (!factory) {
    if (vi.isMockFunction(chromeMcpConnect.createChromeMcpSession)) {
      vi.mocked(chromeMcpConnect.createChromeMcpSession).mockRestore();
    }
    return;
  }
  vi.spyOn(chromeMcpConnect, "createChromeMcpSession").mockImplementation(
    (_owner, profileName, options) => {
      ownedProfiles.add(profileName);
      return factory(profileName, options);
    },
  );
}

export async function resetChromeMcpSessionsForTest(): Promise<void> {
  await Promise.all([...ownedProfiles].map((profileName) => closeChromeMcpSession(profileName)));
  ownedProfiles.clear();
  setChromeMcpSessionFactoryForTest(null);
}

export function waitForChromeMcpState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

export type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type ToolCallMock = {
  mock: {
    calls: Array<[ToolCall, { signal?: AbortSignal; timeout?: number }?]>;
  };
};

export function fakeListPagesResult() {
  return textResult("## Pages\n1: https://example.com [selected]");
}

export function textResult(text: string, isError = false): ChromeMcpToolResult {
  return { ...(isError ? { isError } : {}), content: [{ type: "text", text }] };
}

export type SessionPage = { id: number; url: string; selected?: boolean };

export function createPageSession(params: {
  pages?: SessionPage[];
  pid?: number;
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
          pages: (params.pages ?? [{ id: 1, url: "https://a.example" }]).map(
            ({ id, url, selected }) => ({ id, url, selected }),
          ),
        },
      };
    }
    if (call.name === "evaluate_script") {
      return textResult("```json\nnull\n```");
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
    transport: { pid: params.pid ?? 141 },
    closeTransport: () => client.close(),
    ready: Promise.resolve(),
  } as unknown as ChromeMcpSession;
}

export function installChromeMcpSessionTestHooks() {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    vi.useRealTimers();
  });

  afterEach(async () => {
    await resetChromeMcpSessionsForTest();
    resetChromeMcpProcessMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}

export const FAKE_TARGET_1 = "chrome-mcp:000000000001:1";
const FAKE_TARGET_2 = "chrome-mcp:000000000001:2";
const FAKE_REF = "mcp-ref:000000000001:1";

export function createFakeSession(): ChromeMcpSession {
  let currentUrl =
    "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session";
  const readUrlArg = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value : fallback;
  const callTool = vi.fn(async ({ name, arguments: args }: ToolCall) => {
    if (name === "list_pages") {
      const pageLines = [
        "## Pages",
        `1: ${currentUrl} [selected]`,
        "2: https://github.com/openclaw/openclaw/pull/45318",
      ];
      return textResult(pageLines.join("\n"));
    }
    if (name === "navigate_page") {
      currentUrl = readUrlArg(args?.url, currentUrl);
      return textResult("navigated");
    }
    if (name === "evaluate_script") {
      return textResult("```json\n123\n```");
    }
    if (name === "take_screenshot") {
      const filePath = typeof args?.filePath === "string" ? args.filePath : undefined;
      const format = args?.format === "jpeg" ? "jpeg" : "png";
      if (!filePath) {
        throw new Error("missing filePath");
      }
      await fs.writeFile(`${filePath}.${format}`, Buffer.from(`screenshot:${format}`));
      return textResult(`Saved screenshot to ${filePath}.${format}.`);
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
    transport: { pid: 123 },
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
      ]),
      nextTargetHandleId: 3,
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
