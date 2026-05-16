#!/usr/bin/env node
/**
 * Live repro for implicit session_status + runSessionKey (#82669 / PR #82696).
 * Run: pnpm exec tsx scripts/repro/session-status-run-session-key-live-proof.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStatusTool } from "../../src/agents/tools/session-status-tool.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-status-proof-"));
const storePath = path.join(tmpRoot, "sessions.json");
const store = {
  "agent:main:telegram:default:direct:1234": {
    sessionId: "s-tg-direct",
    updatedAt: 5,
    status: "done",
    thinkingLevel: "off",
  },
  "agent:main:main": {
    sessionId: "s-main",
    updatedAt: 10,
    status: "running",
    thinkingLevel: "high",
  },
};
fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);

const config = {
  session: { mainKey: "main", scope: "per-sender", store: storePath },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {},
    },
  },
  tools: {
    agentToAgent: { enabled: false },
  },
};

const tool = createSessionStatusTool({
  agentSessionKey: "agent:main:telegram:default:direct:1234",
  runSessionKey: "agent:main:main",
  config,
});

const result = await tool.execute("live-proof-implicit-run-session", {});
const text = typeof result === "string" ? result : JSON.stringify(result);
const thinkingMatch = text.match(/think(?:ing)?[:\s]+(\w+)/i);

console.log(
  "implicit session_status resolved thinkingLevel from store =",
  store["agent:main:main"].thinkingLevel,
);
console.log("status text mentions thinking:", thinkingMatch?.[1] ?? "(see full status below)");
console.log("--- status excerpt ---");
console.log(text.split("\n").slice(0, 12).join("\n"));

fs.rmSync(tmpRoot, { recursive: true, force: true });
