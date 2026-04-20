// End-to-end live verification of the Claude Agent SDK runtime driver.
//
// Guarded behind OPENCLAW_LIVE_TEST=1 (the repo convention — see
// vitest.live.config.ts) because it:
//   * spawns the real @anthropic-ai/claude-agent-sdk subprocess
//   * hits Anthropic's API (subscription mode uses the operator's
//     `claude login` session in ~/.claude/)
//   * writes a real JSONL transcript to a tempdir via session-mirror
//
// Run with:
//   OPENCLAW_LIVE_TEST=1 pnpm test:live src/agents/claude-sdk/run.live.test.ts
//
// Use this as the minimum regression signal for Phase 4 deletion: if
// this test runs green against a real subscription, the adapter's
// happy-path plumbing (credential resolution → SDK spawn → message
// iteration → session mirror → EmbeddedPiRunResult) is working.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClaudeSdkAgent } from "./run.js";
import { resolveSessionMirrorPath } from "./session-mirror.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;

describeLive("runClaudeSdkAgent (live, OPENCLAW_LIVE_TEST=1)", () => {
  let tempDir: string;
  let sessionFile: string;
  let workspaceDir: string;
  let agentDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-live-"));
    sessionFile = path.join(tempDir, "session.jsonl");
    workspaceDir = path.join(tempDir, "workspace");
    agentDir = path.join(tempDir, "agent");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeParams(overrides?: Partial<RunEmbeddedPiAgentParams>): RunEmbeddedPiAgentParams {
    // Cast to RunEmbeddedPiAgentParams — live tests don't need the full
    // auto-reply-layer field set; only fields the adapter actually reads.
    return {
      sessionId: `live-${Date.now()}`,
      sessionFile,
      workspaceDir,
      agentDir,
      runId: `live-run-${Date.now()}`,
      // The SDK's Claude Code subprocess does real first-launch init
      // (plugin discovery, MCP handshake, sub-agent catalog). 4 min is
      // comfortable headroom for a cold start on a developer machine.
      timeoutMs: 4 * 60_000,
      prompt: "",
      ...overrides,
    } as RunEmbeddedPiAgentParams;
  }

  // Timeout set generous (5 min) because the Claude Code subprocess the
  // SDK spawns does first-run initialization on cold launch — loading
  // the .claude/agents/ sub-agents, plugin MCP servers, cached models,
  // etc. Real-world happy-path calls are much faster once warm; the
  // timeout here only has to accommodate the worst cold-start case on
  // a developer machine.
  const RUN_TIMEOUT_MS = 5 * 60_000;

  it("answers a trivial prompt via the Claude.ai subscription", async () => {
    const result = await runClaudeSdkAgent(
      makeParams({
        prompt:
          "Reply with exactly the text CLAUDE-SDK-OK and nothing else. No preamble, no punctuation.",
      }),
    );
    expect(result.payloads?.[0]?.text ?? "").toMatch(/CLAUDE-SDK-OK/);
    // agentMeta only appears when an explicit model id was forwarded;
    // see runtime-dispatch.live.test.ts for the rationale.
    if (result.meta.agentMeta) {
      expect(result.meta.agentMeta.provider).toBe("anthropic");
    }
  }, RUN_TIMEOUT_MS);

  it("writes the pi-ai JSONL mirror to the sidecar file", async () => {
    await runClaudeSdkAgent(
      makeParams({
        prompt: "Say hi in one word.",
      }),
    );
    // The mirror writes to a sidecar at <sessionFile>.claude-sdk.jsonl
    // (tagged "system" marker + canonical message envelopes) AND to the
    // primary canonical session file (envelopes only). The sidecar is
    // the deterministic on-disk evidence the run took the SDK path.
    const sidecarPath = resolveSessionMirrorPath(sessionFile);
    const written = fs.readFileSync(sidecarPath, "utf8");
    // First frame is the system kickoff; we expect a canonical
    // message envelope (`type: "message"` with `claudeSdk: true`) from
    // an assistant turn afterward.
    const lines = written
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string; claudeSdk?: boolean; message?: { role?: string } });
    expect(lines[0]?.type).toBe("system");
    expect(
      lines.some(
        (l) => l.type === "message" && l.claudeSdk === true && l.message?.role === "assistant",
      ),
    ).toBe(true);
  }, RUN_TIMEOUT_MS);
});
