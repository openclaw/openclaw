import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("carries whole initialize guidance through the connected SDK client into agent tools", async () => {
  const workspaceDir = tempDirs.make("mcp-initialize-guidance-");
  const serverPath = path.join(workspaceDir, "server.mjs");
  const instructions = `Cite source URIs. ${"context ".repeat(500)}Require confirmation before writing.`;
  await fs.writeFile(
    serverPath,
    `import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  let result;
  if (message.method === "initialize") {
    result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "guidance", version: "1" }, instructions: ${JSON.stringify(instructions)} };
  } else if (message.method === "tools/list") {
    result = { tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
  }
  if (result) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`,
  );
  const runtime = createSessionMcpRuntime({
    sessionId: "initialize-guidance",
    sessionKey: "agent:test:initialize-guidance",
    workspaceDir,
    manifestRegistry: { plugins: [] },
    cfg: {
      plugins: { enabled: false },
      mcp: { servers: { guidance: { command: process.execPath, args: [serverPath] } } },
    },
  });
  try {
    const catalog = await runtime.getCatalog();
    expect(catalog.diagnostics ?? []).toEqual([]);
    expect(catalog.servers.guidance?.instructions).toBe(instructions);
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    try {
      expect(
        materialized.tools.map((tool) => getPluginToolMeta(tool)?.mcp?.serverInstructions),
      ).toEqual([instructions]);
    } finally {
      await materialized.dispose();
    }
  } finally {
    await runtime.dispose();
  }
});
