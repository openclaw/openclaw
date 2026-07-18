/**
 * Runtime proof for openclaw/openclaw#107000.
 * Registers an installed AgentToolResultMiddleware, builds embedded extension
 * factories with agent/session/run identity, fires a tool_result event, and
 * prints the identity fields the middleware actually received.
 *
 * Run: node --import tsx scripts/proof-tool-result-middleware-identity.mjs
 */
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { buildEmbeddedExtensionFactories } from "../src/agents/embedded-agent-runner/extensions.ts";
import { createEmptyPluginRegistry } from "../src/plugins/registry.ts";
import { setActivePluginRegistry } from "../src/plugins/runtime.ts";

const observed = [];

const registry = createEmptyPluginRegistry();
registry.agentToolResultMiddlewares.push({
  pluginId: "proof-identity",
  pluginName: "proof-identity",
  rawHandler: () => undefined,
  handler: (event, ctx) => {
    observed.push({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      runtime: ctx.runtime,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
    });
    return {
      result: {
        content: [{ type: "text", text: "middleware-ok" }],
        details: {},
      },
    };
  },
  runtimes: ["openclaw"],
  source: "proof",
});
setActivePluginRegistry(registry);

const sessionManager = SessionManager.inMemory();
const factories = buildEmbeddedExtensionFactories({
  cfg: undefined,
  sessionManager,
  provider: "openai",
  modelId: "gpt-5.4",
  model: undefined,
  runId: "run-proof-107000",
  agentId: "main",
  sessionId: "session-proof-107000",
  sessionKey: "agent:main:chat",
});

if (!factories.length) {
  console.error("FAIL: no extension factories");
  process.exit(1);
}

const handlers = new Map();
await factories[0]({
  on(event, handler) {
    handlers.set(event, handler);
  },
});

const toolResult = handlers.get("tool_result");
if (!toolResult) {
  console.error("FAIL: no tool_result handler");
  process.exit(1);
}

const result = await toolResult(
  {
    toolName: "read",
    toolCallId: "call-proof-1",
    content: [{ type: "text", text: "raw" }],
    details: {},
  },
  { cwd: "/tmp" },
);

console.log("INSTALLED middleware observations:");
console.log(JSON.stringify(observed, null, 2));
console.log("handler result content:", JSON.stringify(result?.content ?? result));

const ctx = observed[0];
const ok =
  ctx &&
  ctx.runtime === "openclaw" &&
  ctx.agentId === "main" &&
  ctx.sessionId === "session-proof-107000" &&
  ctx.sessionKey === "agent:main:chat" &&
  ctx.runId === "run-proof-107000" &&
  ctx.toolName === "read";

console.log(
  ok
    ? "RESULT: PASS — installed middleware received agent/session/run identity"
    : "RESULT: FAIL — missing identity fields",
);
process.exit(ok ? 0 : 1);
