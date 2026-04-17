// Live integration test for the runtime dispatcher picking up the
// claude-sdk path from config and driving a real SDK turn.
//
// Covers the application-level integration that run.live.test.ts skips
// (that test calls runClaudeSdkAgent directly). Here we call runAgent
// with a config that opts the agent into runtime.type="claude-sdk" and
// verify the full dispatch → adapter → SDK subprocess → JSONL mirror →
// EmbeddedPiRunResult path.
//
// Guarded behind OPENCLAW_LIVE_TEST=1 like other .live.test.ts files.
// Uses the operator's ~/.claude/ subscription session; no API key.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import { runAgent } from "../runtime-dispatch.js";
import { resolveSessionMirrorPath } from "./session-mirror.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;

const AGENT_ID = "live-dispatch-agent";

// 4 min per run — same rationale as run.live.test.ts (SDK subprocess
// cold-start plugin discovery + sub-agent catalog).
const RUN_TIMEOUT_MS = 4 * 60_000;

describeLive("runAgent dispatch → claude-sdk (live)", () => {
  let tempDir: string;
  let sessionFile: string;
  let workspaceDir: string;
  let agentDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-dispatch-live-"));
    sessionFile = path.join(tempDir, "session.jsonl");
    workspaceDir = path.join(tempDir, "workspace");
    agentDir = path.join(tempDir, "agent");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    // Retry loop because the SDK's subprocess sometimes holds open file
    // handles in workspaceDir for a tick after the run resolves. Windows
    // will refuse rmdir while a handle is open; Linux tolerates it.
    for (let i = 0; i < 3; i += 1) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return;
      } catch {
        // wait briefly and retry
      }
    }
  });

  function makeConfigWithClaudeSdkAgent(): OpenClawConfig {
    return {
      agents: {
        list: [
          {
            id: AGENT_ID,
            runtime: { type: "claude-sdk" },
          },
        ],
      },
    } as unknown as OpenClawConfig;
  }

  function makeParams(): RunEmbeddedPiAgentParams {
    return {
      sessionId: `live-dispatch-${Date.now()}`,
      sessionFile,
      workspaceDir,
      agentDir,
      agentId: AGENT_ID,
      runId: `live-dispatch-run-${Date.now()}`,
      timeoutMs: RUN_TIMEOUT_MS,
      prompt:
        "Reply with exactly the text DISPATCH-OK and nothing else. No preamble, no punctuation.",
      config: makeConfigWithClaudeSdkAgent(),
    } as RunEmbeddedPiAgentParams;
  }

  it("routes runAgent() through the claude-sdk adapter when config opts in", async () => {
    const result = await runAgent(makeParams());

    // If the dispatcher had gone to the embedded path, it would have
    // thrown from pi-ai module resolution or returned an embedded-shape
    // result. A passing DISPATCH-OK confirms the SDK drove the turn.
    expect(result.payloads?.[0]?.text ?? "").toMatch(/DISPATCH-OK/);
    expect(result.meta.agentMeta?.provider).toBe("anthropic");

    // The session-mirror sidecar file should exist and have a
    // system frame tagged with the SDK source — unique on-disk
    // evidence the run took the claude-sdk path. We assert against
    // the sidecar path (NOT the primary sessionFile) because pi-ai's
    // SessionManager owns the primary path and may rewrite it.
    const sidecarPath = resolveSessionMirrorPath(sessionFile);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const written = fs.readFileSync(sidecarPath, "utf8");
    const firstLine = written.split("\n").find((l) => l.length > 0);
    expect(firstLine).toBeDefined();
    const parsed = JSON.parse(firstLine!) as { source?: string; type?: string };
    expect(parsed.type).toBe("system");
    expect(parsed.source).toBe("claude-sdk");
  }, RUN_TIMEOUT_MS);
});
