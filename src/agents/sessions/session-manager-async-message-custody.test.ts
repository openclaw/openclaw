import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputSources,
  prepareForeignLiveSessionPendingInputEntries,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
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
