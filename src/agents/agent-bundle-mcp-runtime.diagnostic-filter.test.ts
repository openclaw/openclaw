/** Tests that MCP failure diagnostics carry the discovery filter outage admission judges. */
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { writeListToolsMcpServer } from "./agent-bundle-mcp-stdio.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// The server's own tool filter and the session's denials, which healthy
// discovery applies to raw names before any tool reaches the model.
const discoveryFilter = { toolFilter: { exclude: ["unused_*"] }, deniedToolNames: ["denied_tool"] };

function createNotesRuntime(sessionId: string, serverPath: string) {
  return createSessionMcpRuntime({
    sessionId,
    sessionKey: `agent:test:${sessionId}`,
    workspaceDir: "/workspace",
    cfg: {
      plugins: { enabled: false },
      mcp: {
        servers: {
          notes: {
            command: process.execPath,
            args: [serverPath],
            toolFilter: discoveryFilter.toolFilter,
          },
        },
      },
    },
    toolOverrides: { mcpToolsDeny: { notes: discoveryFilter.deniedToolNames } },
  });
}

it("carries the tool filter and session denials on a failed catalog load", async () => {
  const tempDir = tempDirs.make("bundle-mcp-diagnostic-filter-");
  const serverPath = path.join(tempDir, "server.mjs");
  await writeListToolsMcpServer(
    {
      filePath: serverPath,
      logPath: path.join(tempDir, "server.log"),
      listToolsJsonRpcErrorMessage: "Unknown method",
    },
    receipts.endpoint,
  );
  const runtime = createNotesRuntime("session-diagnostic-filter", serverPath);

  try {
    const catalog = await runtime.getCatalog();

    expect(catalog.servers).toEqual({});
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ serverName: "notes", ...discoveryFilter }),
    ]);
  } finally {
    await runtime.dispose();
  }
});

it("carries the tool filter and session denials on the retirement diagnostic", async () => {
  const runtime = createNotesRuntime("session-retired-filter", "unused.mjs");

  await runtime.dispose();

  // Retirement follows any config publication, so the diagnostic must keep the
  // filter and denials the runtime listed under or a hidden server gets named.
  expect(runtime.peekCatalog()?.diagnostics).toEqual([
    expect.objectContaining({
      serverName: "notes",
      message: expect.stringMatching(/retired/),
      ...discoveryFilter,
    }),
  ]);
});
