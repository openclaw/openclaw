import fs from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, vi } from "vitest";
import * as chromeMcpConnect from "./chrome-mcp-connect.js";
import type {
  ChromeMcpSession,
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

type ToolHandler = (call: ToolCall) => unknown;

export function fakeListPagesResult() {
  return textResult("## Pages\n1: https://example.com [selected]");
}

export function textResult(text: string, isError = false): CallToolResult {
  return { ...(isError ? { isError } : {}), content: [{ type: "text", text }] };
}

export type SessionPage = { id: number; url: string; selected?: boolean };

export function pagesResult(pages: SessionPage[]) {
  return { structuredContent: { pages } };
}

export function createSessionStub(callTool: (call: ToolCall) => Promise<unknown>, pid: number) {
  const client = { callTool, close: vi.fn().mockResolvedValue(undefined) };
  return {
    client,
    transport: { pid },
    closeTransport: () => client.close(),
    ready: Promise.resolve(),
  } as unknown as ChromeMcpSession;
}

export function createPageSession(params: {
  pages?: SessionPage[];
  pid?: number;
  onTool?: ToolHandler | Partial<Record<string, ToolHandler>>;
}): ChromeMcpSession {
  const callTool = vi.fn(async (call: ToolCall) => {
    const handler =
      typeof params.onTool === "function" ? params.onTool : params.onTool?.[call.name];
    const custom = await handler?.(call);
    if (custom !== undefined) {
      return custom;
    }
    if (call.name === "list_pages") {
      return pagesResult(params.pages ?? [{ id: 1, url: "https://a.example" }]);
    }
    if (call.name === "evaluate_script") {
      return textResult("```json\nnull\n```");
    }
    throw new Error(`unexpected tool ${call.name}`);
  });
  return createSessionStub(callTool, params.pid ?? 141);
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

export function createFakeSession(): ChromeMcpSession {
  let currentUrl = "https://example.com";
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

  return {
    ...createSessionStub(callTool, 123),
    routing: {
      sessionNonce: "000000000001",
      withOperationLock: async <T>(operation: () => Promise<T>) => await operation(),
      targetIdByPageId: new Map([
        [1, FAKE_TARGET_1],
        [2, FAKE_TARGET_2],
      ]),
      nextTargetHandleId: 3,
      snapshotsByTarget: new Map(),
      nextSnapshotRefId: 1,
    },
  };
}

export function snapshotWithControls(...children: ChromeMcpSnapshotNode[]): ChromeMcpSnapshotNode {
  return { id: "root", role: "RootWebArea", children };
}
