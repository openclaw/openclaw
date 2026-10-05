import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultSessionStorePath } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveFreshSessionTotalTokens,
  SESSION_TOTAL_TOKENS_VERSION,
} from "../../../config/sessions/types.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { testing } from "../runs.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
});

describe("prepareEmbeddedAttemptStream context total", () => {
  it("publishes a tool-use call's context total from the real subscription", async () => {
    await withStateDirEnv("openclaw-context-total-", async () => {
      const target = {
        agentId: "main",
        sessionId: "session-context-total",
        sessionKey: "agent:main:context-total",
        storePath: resolveDefaultSessionStorePath("main"),
      };
      // The run holds the writer claim, as lane admission installs it.
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        activeWriterRunId: "run-output-schema",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      });
      const { session } = await createTestSession({
        customTools: [
          {
            name: "lookup",
            label: "Lookup",
            description: "Lookup",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "found" }], details: {} }),
          },
        ],
      });
      const toolCall = { type: "toolCall" as const, id: "call-1", name: "lookup", arguments: {} };
      streamMocks.streamSimple
        .mockImplementationOnce((model) =>
          createAssistantResultStream(createAssistant(model, [toolCall], "toolUse", 12_000)),
        )
        .mockImplementationOnce((model) => {
          const final = createAssistant(model, [{ type: "text", text: "Done." }]);
          // The final call has no context snapshot, so only the tool-use call can publish.
          final.usage.contextUsage = { state: "unavailable" };
          return createAssistantResultStream(final);
        });
      const prepared = prepareCatalogExecutor({
        activeSession: session,
        sessionKey: target.sessionKey,
        attempt: { ...target, sessionTarget: target },
      });
      try {
        await session.prompt("Look it up.");
        await prepared.contextTotalTokensWriter.close();
      } finally {
        prepared.subscription.unsubscribe();
      }
      const row = loadSessionEntry({ ...target, readConsistency: "latest" });
      expect(resolveFreshSessionTotalTokens(row)).toBe(12_000);
    });
  });
});
