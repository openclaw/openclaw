import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import * as sessionsHarness from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const MAIN_SESSION_KEY = "agent:test:main";

describe("sessions_spawn fsPolicy defaults", () => {
  beforeEach(() => {
    sessionsHarness.resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    sessionsHarness.getCallGatewayMock().mockClear();
  });

  it("applies tools.sessions_spawn.fsPolicy as a default tightening when params.fsPolicy is omitted", async () => {
    sessionsHarness.setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      tools: {
        sessions_spawn: {
          fsPolicy: {
            workspaceOnly: true,
          },
        },
      },
    });

    const onSessionsPatch = vi.fn();
    const gateway = sessionsHarness.setupSessionsSpawnGatewayMock({ onSessionsPatch });

    const tool = await sessionsHarness.getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });
    await tool.execute("toolcall-1", {
      task: "do something",
      sandbox: "inherit",
      mode: "run",
      cleanup: "delete",
    });

    const child = gateway.getChild();

    // Ensure we patched the child session with an fs ceiling.
    expect(onSessionsPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        key: child.sessionKey,
        spawnedToolFsPolicy: expect.objectContaining({
          workspaceOnly: true,
        }),
      }),
    );
  });
});
