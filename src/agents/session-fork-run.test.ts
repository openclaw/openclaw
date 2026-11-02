import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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
