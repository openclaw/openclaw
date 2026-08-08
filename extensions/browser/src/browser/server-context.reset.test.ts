import { describe, expect, it } from "vitest";
import { createProfileResetOps } from "./server-context.reset.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

describe("profile reset ownership", () => {
  it("identifies attach-only profiles without misdiagnosing them as remote", async () => {
    const profile = makeBrowserProfile({ name: "attached", attachOnly: true });
    const state = makeBrowserServerState({ profile });
    const ops = createProfileResetOps({
      profile,
      state: () => state,
      runtime: {} as never,
      configRevision: 1,
      resolveOpenClawUserDataDir: () => "/tmp/unused",
    });

    await expect(ops.resetProfile()).rejects.toThrow(
      'reset-profile is only supported for OpenClaw-managed local profiles (profile "attached" uses local-attach-only mode).',
    );
  });
});
