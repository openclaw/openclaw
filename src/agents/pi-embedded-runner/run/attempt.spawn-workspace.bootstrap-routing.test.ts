import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt bootstrap routing", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("resolves bootstrap pending from the canonical workspace instead of a copied sandbox", async () => {
    const sandboxWorkspace = "/tmp/openclaw-sandbox-copy";
    let capturedPrompt = "";

    hoisted.resolveSandboxContextMock.mockResolvedValue({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });
    hoisted.isWorkspaceBootstrapPendingMock.mockImplementation(async (workspaceDir: string) => {
      return workspaceDir === sandboxWorkspace;
    });

    await createContextEngineAttemptRunner({
      sessionKey: "agent:main:bootstrap-canonical-workspace",
      tempPaths,
      contextEngine: {
        assemble: async ({ messages }) => ({
          messages,
          estimatedTokens: 1,
        }),
      },
      attemptOverrides: {
        disableTools: true,
      },
      sessionPrompt: async (session, prompt) => {
        capturedPrompt = prompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 } as never,
        ];
      },
    });

    expect(hoisted.isWorkspaceBootstrapPendingMock).toHaveBeenCalledTimes(1);
    expect(hoisted.isWorkspaceBootstrapPendingMock).not.toHaveBeenCalledWith(sandboxWorkspace);
    expect(capturedPrompt).not.toContain("[Bootstrap pending]");
  });
});
