import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginAuthContext } from "../../plugins/types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent delegated auth context", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("forwards channel auth context into the embedded attempt", async () => {
    const pluginAuth: OpenClawPluginAuthContext = {
      getDelegatedAccessToken: vi.fn(async (_request) => ({
        ok: true as const,
        token: "token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      messageChannel: "msteams",
      messageProvider: "msteams",
      messageChatType: "direct",
      pluginAuth,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        messageChannel: "msteams",
        messageProvider: "msteams",
        messageChatType: "direct",
        pluginAuth,
      }),
    );
  });
});
