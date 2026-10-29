import { syncBuiltinESMExports } from "node:module";
import v8 from "node:v8";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputSources,
  prepareForeignLiveSessionPendingInputEntries,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { assistantText, withSessionState } from "./session-manager-fixtures.test-support.js";
import { withSelectedTranscriptReader } from "./session-manager-reader.test-support.js";
import { SessionManager } from "./session-manager.js";

const user = (key: string) => ({
  role: "user" as const,
  content: `Synthetic input ${key}`.repeat(4096),
  timestamp: 1,
  idempotencyKey: `${key}:user`,
});

it.each([false, true])(
  "preserves pending custody, slim actor appends, and closed replay (collected: %s)",
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
      const sources = collected ? [firstSource, await stage("second")] : [firstSource];
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
        if (collected) {
          const requestBytes: number[] = [];
          const serialize = v8.serialize;
          // Native worker clients bypass Vite mocks; observe their actual serialization too.
          v8.serialize = (value: unknown) => {
            const bytes = serialize(value);
            if (
              isRecord(value) &&
              (value.type === "session.actor.appendTranscriptEvent" ||
                value.type === "session.actor.appendToolResult")
            ) {
              requestBytes.push(bytes.byteLength);
            }
            return bytes;
          };
          syncBuiltinESMExports();
          onTestFinished(() => {
            v8.serialize = serialize;
            syncBuiltinESMExports();
          });

          const fresh = vi.fn();
          const appendReplies = async () => {
            for (const message of [
              assistantText("Synthetic answer"),
              makeTextToolResult("synthetic-tool", "lookup", "Synthetic result", false, 2),
            ]) {
              await manager.appendMessageWithTranscriptAnchorAsync(message, {
                beforeFreshMessageCommit: fresh,
              });
            }
          };
          const appendOwned = () => withSessionPendingInputPersistence(receipt, appendReplies);
          await withSelectedTranscriptReader(target, appendOwned, true);
          expect(requestBytes).toHaveLength(2);
          expect(Math.max(...requestBytes)).toBeLessThan(8192);
          expect(fresh).toHaveBeenCalledTimes(2);
        }
        expect(await loadTranscriptEvents(target)).toEqual(manager.getPersistedEntries());
      } finally {
        receipt.finish("interrupted");
        for (const source of sources) {
          source.finish("interrupted");
        }
      }
    }),
);
