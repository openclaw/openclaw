import { syncBuiltinESMExports } from "node:module";
import v8 from "node:v8";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputSources,
  prepareForeignLiveSessionPendingInputEntries,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { captureDurableSessionActor } from "../../config/sessions/session-actor-durable.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { assistantText, withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

const user = (key: string) => ({
  role: "user" as const,
  content: `Synthetic input ${key}`,
  timestamp: 1,
  idempotencyKey: `${key}:user`,
});

it.each([false, true])(
  "preserves pending custody and closed committed replay (collected: %s)",
  (collected) =>
    withSessionState(`pending-messages-${collected}`, async ({ scope: target, state }) => {
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const stage = async (key: string) =>
        expectDefined(
          await stageSessionPendingInput(target, {
            runId: key,
            message: user(key),
            assertCurrent: () => {},
          }),
          "Expected pending input custody",
        );
      const firstSource = await stage("first");
      const sources = [firstSource];
      if (collected) {
        sources.push(await stage("second"));
      }
      const receipt = collected
        ? expectDefined(
            bindSessionPendingInputSources(sources, user("aggregate")),
            "Expected aggregate custody",
          )
        : firstSource;
      const beforeFreshMessageCommit = vi.fn(() => {
        throw new Error("Accepted input must retain its original admission");
      });
      try {
        await expect(manager.appendMessageAsync(firstSource.message)).rejects.toThrow(
          "admitted turn",
        );
        const committed = await receipt.run(() =>
          manager.appendMessageWithTranscriptAnchorAsync(receipt.message, {
            beforeFreshMessageCommit,
          }),
        );
        expect(committed).toMatchObject({
          entryId: receipt.inputId,
          message: receipt.message,
          appended: true,
        });
        expect([receipt.state, ...sources.map((source) => source.state)]).toEqual(
          Array(sources.length + 1).fill("consumed"),
        );
        expect(beforeFreshMessageCommit).not.toHaveBeenCalled();
        const readForeign = await prepareForeignLiveSessionPendingInputEntries(target);
        expect(readForeign().has(receipt.inputId)).toBe(true);
        expect(
          await receipt.run(async () =>
            (await prepareForeignLiveSessionPendingInputEntries(target))().has(receipt.inputId),
          ),
        ).toBe(false);
        const events = await loadTranscriptEvents(target);
        expect(events).toEqual(manager.getPersistedEntries());
        if (collected) {
          firstSource.finish("interrupted");
          await firstSource.settled?.();
          expect(readForeign().has(receipt.inputId)).toBe(true);
        }
        receipt.finish("cancelled");
        expect(readForeign().has(receipt.inputId)).toBe(false);
        await expect(
          withSessionPendingInputPersistence(receipt, () =>
            manager.appendMessageWithTranscriptAnchorAsync(receipt.message, {
              beforeFreshMessageCommit,
            }),
          ),
        ).resolves.toMatchObject({ entryId: receipt.inputId, appended: false });
        expect(beforeFreshMessageCommit).not.toHaveBeenCalled();
        expect(await loadTranscriptEvents(target)).toEqual(events);
      } finally {
        receipt.finish("interrupted");
        for (const source of sources) {
          source.finish("interrupted");
        }
      }
    }),
);

it("does not resend pending user content with assistant and tool-result appends", () =>
  withSessionState("pending-payload", async ({ scope, state }) => {
    const requestBytes = new Map<string, number[]>();
    const serialize = v8.serialize;
    // Native worker clients bypass Vite mocks; observe their actual serialization too.
    v8.serialize = (value: unknown) => {
      const bytes = serialize(value);
      if (value && typeof value === "object" && "type" in value && typeof value.type === "string") {
        const sizes = requestBytes.get(value.type) ?? [];
        sizes.push(bytes.byteLength);
        requestBytes.set(value.type, sizes);
      }
      return bytes;
    };
    syncBuiltinESMExports();
    onTestFinished(() => {
      v8.serialize = serialize;
      syncBuiltinESMExports();
    });
    const manager = await SessionManager.openAsync(scope, state.workspaceDir);
    const message = { ...user("large"), content: "Synthetic pending input. ".repeat(4096) };
    const pending = expectDefined(
      await stageSessionPendingInput(scope, { runId: "large", message, assertCurrent() {} }),
      "Expected pending input custody",
    );
    const database = { agentId: scope.agentId, path: scope.storePath };
    const identity = readOpenClawAgentDatabaseIdentity(openOpenClawAgentDatabase(database));
    const authority = { assertCurrent() {}, assertReadable() {}, authorize() {} };
    const actor = captureDurableSessionActor({
      database,
      target: {
        sessionKey: scope.sessionKey,
        database: {
          kind: "file",
          physicalIdentity: identity.identity,
          birthtime: identity.birthtime,
          nativeLocation: identity.canonicalPath,
        },
      },
      lifetime: authority,
    });
    const fresh = vi.fn();
    try {
      await actor.read(authority);
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionActor: { actor, database },
          withTranscriptWrite: async (write) => write(),
        },
        () =>
          pending.run(async () => {
            await manager.appendMessageAsync(pending.message);
            requestBytes.clear();
            await manager.appendMessageWithTranscriptAnchorAsync(
              assistantText("Synthetic answer"),
              {
                beforeFreshMessageCommit: fresh,
              },
            );
            await manager.appendMessageWithTranscriptAnchorAsync(
              {
                role: "toolResult",
                toolCallId: "synthetic-tool",
                toolName: "lookup",
                content: [{ type: "text", text: "Synthetic result" }],
                isError: false,
                timestamp: 2,
              },
              { beforeFreshMessageCommit: fresh },
            );
          }),
      );
      for (const type of [
        "session.actor.appendTranscriptEvent",
        "session.actor.appendToolResult",
      ]) {
        const sizes = requestBytes.get(type);
        expect(sizes).toHaveLength(1);
        expect(sizes![0]).toBeLessThan(8192);
      }
      expect(fresh).toHaveBeenCalled();
      expect(pending.state).toBe("consumed");
      expect(await loadTranscriptEvents(scope)).toEqual(manager.getPersistedEntries());
    } finally {
      pending.finish("interrupted");
      await actor.release();
    }
  }));
