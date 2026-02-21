import { GraphService } from "../src/services/memory/GraphService.js";

async function main() {
  const graph = new GraphService();
  const url = `${graph.mcpBaseURL}/mcp`;

  try {
    const mcpId = await graph.ensureSession();
    const payload = {
      jsonrpc: "2.0",
      id: "3",
      method: "tools/list",
      params: {},
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": mcpId,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    console.log("--- AVAILABLE TOOLS ---\n");
    console.log(text);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${message}`);
  }
}

void main();
