import { describe, expect, it, vi } from "vitest";
import {
  createSessionsSpawnTool,
  setupSessionsSpawnGatewayMock,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";

describe("sessions_spawn fsPolicy defaults", () => {
  it("applies tools.sessions_spawn.fsPolicy as a default tightening when params.fsPolicy is omitted", async () => {
    setSessionsSpawnConfigOverride({
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
    } as unknown);

    const onSessionsPatch = vi.fn();
    const gateway = setupSessionsSpawnGatewayMock({ onSessionsPatch });

    const tool = createSessionsSpawnTool({
      cfg: (await import("../config/config.js")).loadConfig(),
      allowSubagents: true,
    } as unknown);

    const child = gateway.getChild();

    await tool.execute("toolcall-1", {
      task: "do something",
      agentId: "main",
      sandbox: "inherit",
      mode: "run",
      cleanup: "delete",
    } as unknown);

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
