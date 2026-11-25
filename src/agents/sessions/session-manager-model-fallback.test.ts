import { assert, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { SessionEntryChangedDuringReadError } from "../../config/sessions/session-entry-read-errors.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { PreparedSessionEntryWorkerRead } from "../../config/sessions/session-entry-read-runtime.types.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { withSelectedTranscriptReader } from "./session-manager-reader.test-support.js";
import { SessionManager } from "./session-manager.js";

it("preserves the selected model and committed input when an ordered session read is invalidated", () =>
  withSessionState("fallback-session-read", async ({ scope }) => {
    const writer = await SessionManager.openAsync(scope);
    await writer.appendMessageAsync(makeUserMessage("Plan the museum visit", 1));
    const entry = loadSessionEntry(scope);
    assert(entry, "Expected the committed session entry");
    let preparations = 0;
    const consume = vi.fn(
      (reads: readonly PreparedSessionEntryWorkerRead[]) =>
        reads[0]?.result.entries[0]?.entry.label,
    );
    const run = vi.fn(() =>
      withSelectedTranscriptReader(scope, async () => {
        const label = await withSessionEntriesFromStoresInWorker(
          [{ ...scope, sessionKeys: [scope.sessionKey] }],
          consume,
          {
            ordered: true,
            prepareConsume: async () => {
              if (preparations++ === 0) {
                // Native writes must invalidate a prepared read before consumption.
                replaceSessionEntrySync(scope, { ...entry, label: "Planning" });
              }
            },
          },
        );
        const manager = await SessionManager.openModelContextAsync(scope);
        return { label, messages: manager.buildSessionContext().messages };
      }),
    );
    const onError = vi.fn();
    const onFallbackStep = vi.fn();
    const options = {
      cfg: undefined,
      provider: "fixture-provider",
      model: "selected",
      manifestPlugins: [],
      fallbacksOverride: ["fixture-next/fallback"],
      run,
      onError,
      onFallbackStep,
    };
    await expect(runWithModelFallback(options)).rejects.toBeInstanceOf(
      SessionEntryChangedDuringReadError,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onFallbackStep).not.toHaveBeenCalled();
    // A fresh admission consumes current metadata and the same committed input.
    await expect(runWithModelFallback(options)).resolves.toMatchObject({
      outcome: "completed",
      provider: "fixture-provider",
      model: "selected",
      attempts: [],
      result: {
        label: "Planning",
        messages: [{ role: "user", content: "Plan the museum visit" }],
      },
    });
    expect(consume).toHaveBeenCalledOnce();
  }));
