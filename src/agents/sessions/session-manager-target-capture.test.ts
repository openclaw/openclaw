import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteAssertion as withAuthority } from "../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { sessionScope, withSessionState } from "./session-manager-fixtures.test-support.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import type { SessionEntry } from "./session-manager-types.js";
import { SessionManager } from "./session-manager.js";

it.each(["binding", "authority"] as const)(
  "retains committed raw-write facts after a %s change",
  (change) =>
    withSessionState(`raw-${change}`, async ({ scope: original }) => {
      const replacement = sessionScope(original.storePath, `other-${change}`);
      await replaceSessionEntry(replacement, { sessionId: replacement.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(original);
      const seed = expectDefined(
        await manager.appendMessageAsync(makeUserMessage("Synthetic seed", 1)),
        "Expected committed seed",
      );
      const before = await loadTranscriptEvents(original);
      const replacementBefore = await loadTranscriptEvents(replacement);
      const raw: SessionEntry = {
        type: "custom",
        customType: "committed-raw",
        id: `raw-entry-${change}`,
        parentId: seed,
        timestamp: new Date(2).toISOString(),
      };
      let active = true;
      const runExternalRetarget = AsyncLocalStorage.snapshot();
      const withWorker = metadataRuntime.withSessionMetadataWorker;
      const delayPublication: typeof withWorker = async (...args) => {
        const receipt = await withWorker(...args);
        if (change === "binding") {
          await runExternalRetarget(() => manager.setSessionTargetAsync(replacement));
        } else {
          active = false;
        }
        return receipt;
      };
      const delayed = vi
        .spyOn(metadataRuntime, "withSessionMetadataWorker")
        .mockImplementation(delayPublication);
      try {
        const persist = () => manager.persistAsync(raw);
        const assertActive = () => assert(active, "Raw write authority ended after commit");
        const failure = await (
          change === "binding" ? persist() : withAuthority(original, assertActive, persist)
        ).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          name: "SessionEntryCommittedError",
          committedEntryId: raw.id,
          committedTarget: original,
          committedVersion: {
            generation: expect.any(String),
            rawSeq: expect.any(Number),
            updatedAt: expect.any(Number),
          },
        });
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
        expect(() => manager.getEntries()).toThrow("Session entry committed");
      } finally {
        delayed.mockRestore();
      }
      expect(await loadTranscriptEvents(original)).toEqual([...before, raw]);
      expect(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
    }),
);

it.each([
  { entry: "open", storePath: "sessions.json", linked: false },
  { entry: "open", storePath: "custom-store.json", linked: false },
  { entry: "open", storePath: "linked/session-store.sqlite", linked: true },
  { entry: "openBounded", storePath: "session-store.sqlite", linked: false },
  { entry: "setSessionTarget", storePath: "session-store.sqlite", linked: false },
  { entry: "openAsync", storePath: "linked/session-store.sqlite", linked: true },
  { entry: "openBoundedAsync", storePath: "session-store.sqlite", linked: false },
  { entry: "setSessionTargetAsync", storePath: "session-store.sqlite", linked: false },
] as const)(
  "$entry captures $storePath before reads and callbacks can change cwd",
  ({ entry, storePath, linked }) =>
    withOpenClawTestState({ label: "manager-target-capture" }, async (state) => {
      const previousCwd = process.cwd();
      const firstDir = state.path("first");
      const secondDir = state.path("second");
      for (const dir of [firstDir, secondDir]) {
        await mkdir(dir, { recursive: true });
        if (linked) {
          const physical = path.join(dir, "physical");
          await mkdir(physical);
          await symlink(physical, path.join(dir, "linked"), "junction");
        }
      }
      const relative = sessionScope(storePath, "capture");
      const first = { ...relative, storePath: path.join(firstDir, storePath) };
      const second = { ...relative, storePath: path.join(secondDir, storePath) };
      for (const target of [first, second]) {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
        const writer = SessionManager.open(target);
        writer.appendMessage(makeUserMessage("older", 1));
        writer.appendMessage(makeUserMessage("current", 2));
      }
      const firstBefore = await loadTranscriptEvents(first);
      const secondBefore = await loadTranscriptEvents(second);
      try {
        process.chdir(firstDir);
        const onTruncated = vi.fn(() => process.chdir(secondDir));
        let manager: SessionManager;
        if (entry === "openBounded" || entry === "openBoundedAsync") {
          const limits = { cwd: firstDir, maxEvents: 1, maxBytes: 4096, onTruncated };
          manager = await SessionManager[entry](relative, limits);
        } else if (entry === "setSessionTargetAsync" || entry === "setSessionTarget") {
          manager = SessionManager.inMemory(firstDir);
          const pending = manager[entry](relative);
          process.chdir(secondDir);
          await pending;
        } else {
          const pending = SessionManager[entry](relative, firstDir);
          process.chdir(secondDir);
          manager = await pending;
        }
        expect(process.cwd()).toBe(secondDir);
        const id = await manager.appendThinkingLevelChange("high");
        expect.soft(manager.getSessionTarget()).toMatchObject({
          ...first,
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        });
        expect
          .soft(await loadTranscriptEvents(first))
          .toEqual([
            ...firstBefore,
            expect.objectContaining({ type: "thinking_level_change", id, thinkingLevel: "high" }),
          ]);
        expect.soft(await loadTranscriptEvents(second)).toEqual(secondBefore);
      } finally {
        process.chdir(previousCwd);
      }
    }),
);
