import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { writeExecutable } from "./bundle-mcp-shared.test-harness.js";

vi.mock("./embedded-agent-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedded-agent-mcp.js")>();
  return {
    loadEmbeddedAgentMcpConfig: (
      params: Parameters<typeof actual.loadEmbeddedAgentMcpConfig>[0],
    ) => ({
      diagnostics: [],
      prepareDataDirsByServer: {},
      mcpServers: Object.fromEntries(
        Object.entries(params.cfg?.mcp?.servers ?? {}).filter(([name]) => {
          const overrides = params.toolOverrides?.mcpServers;
          return !(overrides && Object.hasOwn(overrides, name) && overrides[name] === false);
        }),
      ),
    }),
  };
});

vi.mock("./mcp-auth-profile.js", () => ({
  resolveMcpAuthProfileId: () => undefined,
  withMcpAuthProfileBearer: () => {
    throw new Error("Unexpected auth-profile transport in MCP diagnostics test");
  },
}));

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);

async function writeTimelineMcpServer(filePath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
let buffer = "";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "timeline-probe", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "timeline_tool", inputSchema: { type: "object" } }] },
    });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
}

it("emits nested diagnostics timeline spans for server catalog discovery", async () => {
  const tempDir = tempDirTracker.make("bundle-mcp-timeline-");
  const serverPath = path.join(tempDir, "server.mjs");
  const timelinePath = path.join(tempDir, "timeline.jsonl");
  await writeTimelineMcpServer(serverPath);
  const previousTimelinePath = process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
  let runtime: SessionMcpRuntime | undefined;

  try {
    process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
    runtime = createSessionMcpRuntime({
      sessionId: "session-timeline",
      workspaceDir: tempDir,
      cfg: {
        diagnostics: { flags: ["timeline"] },
        mcp: {
          servers: {
            bundleProbe: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });
    const catalog = await runtime.getCatalog();
    expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["timeline_tool"]);
    const timelineText = await fs.readFile(timelinePath, "utf8");
    const events = timelineText
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            attributes?: Record<string, unknown>;
            durationMs?: number;
            name: string;
            parentSpanId?: string;
            spanId?: string;
            type: string;
          },
      );
    const endEvent = (name: string) =>
      events.find((event) => event.name === name && event.type === "span.end");
    const serverSpan = endEvent("bundle-mcp.server");
    const connectSpan = endEvent("bundle-mcp.connect");
    const toolsListSpan = endEvent("bundle-mcp.tools-list");

    expect(serverSpan).toMatchObject({
      attributes: {
        reusedSession: false,
        safeServerName: "bundleProbe",
        serverName: "bundleProbe",
        transportType: "stdio",
      },
      durationMs: expect.any(Number),
    });
    expect(connectSpan).toMatchObject({
      durationMs: expect.any(Number),
      parentSpanId: serverSpan?.spanId,
    });
    expect(toolsListSpan).toMatchObject({
      durationMs: expect.any(Number),
      parentSpanId: serverSpan?.spanId,
    });
    expect(timelineText).not.toContain(serverPath);
  } finally {
    await runtime?.dispose();
    if (previousTimelinePath === undefined) {
      delete process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
    } else {
      process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = previousTimelinePath;
    }
  }
});
