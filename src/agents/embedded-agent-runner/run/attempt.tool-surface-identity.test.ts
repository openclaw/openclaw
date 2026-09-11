import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("embedded tool surface execution identity", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each(["global", "agent:main:main"])(
    "keeps policy session %s separate from execution planning",
    async (sandboxSessionKey) => {
      hoisted.createOpenClawCodingToolsMock.mockReturnValue([
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
          execute: async () => "",
        },
      ]);
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:worker:main",
        tempPaths,
        attemptOverrides: {
          agentId: "worker",
          sandboxAgentId: "main",
          sandboxSessionKey,
          sessionTarget: undefined,
          disableTools: false,
          config: {
            agents: {
              entries: {
                main: { tools: { codeMode: { enabled: false } } },
                worker: { tools: { codeMode: { enabled: true } } },
              },
            },
          },
        },
      });

      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: sandboxSessionKey,
          runSessionKey: "agent:worker:main",
        }),
        undefined,
      );
      expect(hoisted.createAgentSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          customTools: expect.arrayContaining([expect.objectContaining({ name: "exec" })]),
        }),
      );
    },
  );
});
