import { describe, expect, it } from "vitest";
import {
  resolveSubagentSpawnAcceptedNote,
  SUBAGENT_SPAWN_ACCEPTED_NOTE,
  SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE,
} from "./subagent-spawn-accepted-note.js";

describe("sessions_spawn: cron isolated session note suppression", () => {
  it("suppresses ACCEPTED_NOTE for cron isolated sessions (mode=run)", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBeUndefined();
  });

  it("preserves ACCEPTED_NOTE for regular sessions (mode=run)", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:telegram:63448508",
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("keeps regular run guidance push-based and completion-gated", () => {
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain("Auto-announce is push-based");
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain("Continue any independent work");
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "call sessions_yield to end the turn and wait for completion events as user messages",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "After ALL expected completions arrive, send the final answer even when some children failed, timed out, or returned partial results",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "Reply ONLY with NO_REPLY when the exact same child completion result was already delivered",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).not.toContain(
      "If a child completion event arrives AFTER your final answer",
    );
  });

  it("preserves ACCEPTED_NOTE for non-canonical cron-like keys", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:slack:cron:job:run:uuid",
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("preserves ACCEPTED_NOTE when agentSessionKey is undefined", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: undefined,
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("uses the session note for cron session-mode spawns", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "session",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBe(SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE);
  });
});
