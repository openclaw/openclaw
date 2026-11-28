import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { assertSessionForkRunSucceeded } from "./session-fork-result.js";
import { prepareSessionFork } from "./session-fork-run.js";

let state: OpenClawTestState;
const model = { provider: "openai", model: "gpt-test" };
const tools = ["skill_workshop"];

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await state.cleanup();
});

async function groupSession() {
  const source = {
    agentId: "main",
    sessionId: "group-session",
    sessionKey: "agent:main:whatsapp:group:team",
    storePath: path.join(state.root, "sessions.json"),
  };
  await upsertSessionEntryCore(source, {
    sessionId: source.sessionId,
    updatedAt: 1,
  });
  return source;
}

const groupTools = (deny: string[]): OpenClawConfig => ({
  channels: { whatsapp: { groups: { team: { tools: { deny } } } } },
});

it("admits a fork only when the source group's policy exposes every fork tool", async () => {
  const source = await groupSession();
  const fork = (config: OpenClawConfig) =>
    prepareSessionFork({ config, source, tools, model, workspaceDir: state.workspaceDir });

  await expect(fork(groupTools(["exec"]))).resolves.toEqual({
    workspaceDir: state.workspaceDir,
  });
  // The group comes from the source session key, not from a live turn.
  await expect(fork(groupTools(["skill_workshop"]))).resolves.toBeUndefined();
});

it("applies wildcard sender restrictions although a fork has no sender", async () => {
  const source = await groupSession();
  const config: OpenClawConfig = {
    tools: { toolsBySender: { "*": { deny: ["skill_workshop"] } } },
  };

  await expect(
    prepareSessionFork({ config, source, tools, model, workspaceDir: state.workspaceDir }),
  ).resolves.toBeUndefined();
});

describe("assertSessionForkRunSucceeded", () => {
  type Result = Parameters<typeof assertSessionForkRunSucceeded>[0];
  const review = (
    meta: Omit<Result["meta"], "durationMs">,
    payloads?: Result["payloads"],
    assertSourceCurrent?: () => void,
  ) =>
    expect(() =>
      assertSessionForkRunSucceeded(
        { meta: { durationMs: 1, ...meta }, payloads },
        assertSourceCurrent,
      ),
    );
  it("does not fail a fork whose tool calls were denied or errored", () => {
    const warning = setReplyPayloadMetadata(
      { isError: true, text: "⚠️ skill_workshop failed: View it first." },
      { toolErrorWarning: { toolName: "skill_workshop" } },
    );
    review(
      {
        toolSummary: {
          calls: 3,
          tools: ["sessions_yield", "skill_workshop"],
          failures: 1,
          unresolvedError: { toolName: "skill_workshop" },
        },
      },
      [warning],
    ).not.toThrow();
  });

  it("fails on model or runtime errors", () => {
    review({ error: { kind: "retry_limit", message: "model retries exhausted" } }).toThrow(
      "model retries exhausted",
    );
    review({}, [{ isError: true, text: "LLM request failed: 529 overloaded" }]).toThrow(
      "529 overloaded",
    );
    review({ aborted: true }).toThrow("aborted");
  });

  it("retains a source fence instead of replacing it with terminal result text", () => {
    const sourceFailure = Object.assign(new Error("Completed-turn transcript anchor changed"), {
      name: "SessionTranscriptReadFenceError",
    });
    review(
      { error: { kind: "incomplete_turn", message: "admitted run authority is inactive" } },
      undefined,
      () => {
        throw sourceFailure;
      },
    ).toThrow(sourceFailure);
  });
});
