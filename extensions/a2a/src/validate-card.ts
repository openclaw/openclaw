/**
 * Quick script: validates Agent Card against A2A spec by fetching
 * from a mini test server.
 */
import http from "node:http";
import { buildAgentCard } from "./agent-card.js";

const PORT = 19878;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
    const card = buildAgentCard({
      agents: [
        { id: "main", description: "Primary assistant" },
        { id: "researcher", description: "Deep research agent" },
      ],
      gatewayUrl: `http://localhost:${PORT}`,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(card, null, 2));
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise<void>((resolve) => server.listen(PORT, resolve));

// Fetch and display
const res = await fetch(`http://localhost:${PORT}/.well-known/agent.json`);
const card = await res.json();
console.log(JSON.stringify(card, null, 2));

// Validate A2A spec compliance
const checks: [string, boolean][] = [
  ["name is string", typeof card.name === "string"],
  ["description is string", typeof card.description === "string"],
  ["url is string", typeof card.url === "string"],
  ["version is string", typeof card.version === "string"],
  ["capabilities exists", typeof card.capabilities === "object"],
  ["capabilities.streaming is boolean", typeof card.capabilities.streaming === "boolean"],
  ["skills is array", Array.isArray(card.skills)],
  ["skills[0].id is string", typeof card.skills?.[0]?.id === "string"],
  ["skills[0].name is string", typeof card.skills?.[0]?.name === "string"],
  ["skills[0].tags is array", Array.isArray(card.skills?.[0]?.tags)],
  ["skills[0].inputModes is array", Array.isArray(card.skills?.[0]?.inputModes)],
  ["skills[0].outputModes is array", Array.isArray(card.skills?.[0]?.outputModes)],
  ["defaultInputModes is array", Array.isArray(card.defaultInputModes)],
  ["defaultOutputModes is array", Array.isArray(card.defaultOutputModes)],
];

console.log("\nA2A spec compliance:");
let ok = 0;
for (const [msg, pass] of checks) {
  console.log(pass ? "  ✓" : "  ✗", msg);
  if (pass) ok++;
}
console.log(`\n${ok}/${checks.length} passed`);
server.close();
