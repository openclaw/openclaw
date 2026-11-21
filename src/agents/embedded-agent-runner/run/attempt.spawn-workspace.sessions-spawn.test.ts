import { describe, expect, it } from "vitest";
import { resolveAttemptSpawnWorkspaceDir } from "./attempt-thread-helpers.js";

describe("runEmbeddedAttempt sessions_spawn workspace inheritance", () => {
  it("passes the real workspace to sessions_spawn when workspaceAccess is ro", () => {
    const realWorkspace = "/tmp/openclaw-real-workspace";
    expect(
      resolveAttemptSpawnWorkspaceDir({
        sandbox: { enabled: true, workspaceAccess: "ro" },
        resolvedWorkspace: realWorkspace,
      }),
    ).toBe(realWorkspace);
  });
});
