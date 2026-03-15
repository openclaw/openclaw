import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";

const callGatewayMock = getCallGatewayMock();

async function getAcceptedNote() {
  const { SUBAGENT_SPAWN_ACCEPTED_NOTE } = await import("./subagent-spawn.js");
  return SUBAGENT_SPAWN_ACCEPTED_NOTE;
}

async function resetRegistry() {
  const { resetSubagentRegistryForTests } = await import("./subagent-registry.js");
  resetSubagentRegistryForTests();
}

type SpawnResult = { status?: string; note?: string };

describe("sessions_spawn: cron isolated session note suppression", () => {
  beforeEach(async () => {
    callGatewayMock.mockReset();
    await resetRegistry();
    resetSessionsSpawnConfigOverride();
  });

  it("suppresses ACCEPTED_NOTE for cron isolated sessions (mode=run)", async () => {
    setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
    });
    const result = await tool.execute("call-cron-run", { task: "test task", mode: "run" });
    const details = result.details as SpawnResult;
    expect(details.note).toBeUndefined();
    expect(details.status).toBe("accepted");
  });

  it("preserves ACCEPTED_NOTE for regular sessions (mode=run)", async () => {
    const acceptedNote = await getAcceptedNote();
    setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:telegram:63448508",
    });
    const result = await tool.execute("call-regular-run", { task: "test task", mode: "run" });
    const details = result.details as SpawnResult;
    expect(details.note).toBe(acceptedNote);
    expect(details.status).toBe("accepted");
  });

  it("does not suppress ACCEPTED_NOTE for non-canonical cron-like keys", async () => {
    const acceptedNote = await getAcceptedNote();
    setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:slack:cron:job:run:uuid",
    });
    const result = await tool.execute("call-cron-like-noncanonical", {
      task: "test task",
      mode: "run",
    });
    expect((result.details as SpawnResult).note).toBe(acceptedNote);
  });

  it("does not suppress note when agentSessionKey is undefined", async () => {
    const acceptedNote = await getAcceptedNote();
    setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({
      agentSessionKey: undefined,
    });
    const result = await tool.execute("call-no-key", { task: "test task", mode: "run" });
    expect((result.details as SpawnResult).note).toBe(acceptedNote);
  });
});
