import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import type { SessionEntry } from "./session-manager-types.js";
import { SessionManager } from "./session-manager.js";

it("retains committed raw-write facts when target binding or authority changes before publication", async () => {
  await withOpenClawTestState({ label: "manager-raw-commit-publication" }, async (state) => {
    for (const change of ["binding", "authority"] as const) {
      const original = {
        agentId: "main",
        sessionId: `raw-${change}`,
        sessionKey: `agent:main:raw-${change}`,
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      const replacement = {
        ...original,
        sessionId: `other-${change}`,
        sessionKey: `agent:main:other-${change}`,
      };
      for (const target of [original, replacement]) {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      }
      const manager = await SessionManager.openAsync(original);
      const seed = expectDefined(
        await manager.appendMessageAsync({ role: "user", content: "Synthetic seed", timestamp: 1 }),
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
      const withWorker = metadataRuntime.withSessionMetadataWorker;
      const delayPublication: typeof withWorker = async (
        options,
        database,
        assertCurrent,
        operation,
        controls,
      ) => {
        const receipt = await withWorker(options, database, assertCurrent, operation, controls);
        if (change === "binding") {
          await manager.setSessionTargetAsync(replacement);
        } else {
          active = false;
        }
        return receipt;
      };
      const delayed = vi
        .spyOn(metadataRuntime, "withSessionMetadataWorker")
        .mockImplementation(delayPublication);
      let failure: unknown;
      try {
        const persist = () => manager.persistAsync(raw);
        await (
          change === "binding"
            ? persist()
            : withSessionTranscriptWriteAssertion(
                original,
                () => {
                  if (!active) {
                    throw new Error("Raw write authority ended after commit");
                  }
                },
                persist,
              )
        ).catch((error: unknown) => {
          failure = error;
        });
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
    }
  });
});

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
  async ({ entry, storePath, linked }) => {
    await withOpenClawTestState({ label: "manager-target-capture" }, async (state) => {
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
      const relative = {
        agentId: "main",
        sessionId: "capture",
        sessionKey: "agent:main:capture",
        storePath,
      };
      const first = { ...relative, storePath: path.join(firstDir, storePath) };
      const second = { ...relative, storePath: path.join(secondDir, storePath) };
      for (const [target, label] of [
        [first, "first"],
        [second, "second"],
      ] as const) {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
        const writer = SessionManager.open(target);
        writer.appendMessage({ role: "user", content: `${label} older`, timestamp: 1 });
        writer.appendMessage({ role: "user", content: `${label} current`, timestamp: 2 });
      }
      const firstBefore = await loadTranscriptEvents(first);
      const secondBefore = await loadTranscriptEvents(second);
      try {
        process.chdir(firstDir);
        const onTruncated = vi.fn(() => process.chdir(secondDir));
        let manager: SessionManager;
        if (entry === "openBounded" || entry === "openBoundedAsync") {
          const open =
            entry === "openBounded"
              ? SessionManager.openBounded.bind(SessionManager)
              : SessionManager.openBoundedAsync.bind(SessionManager);
          manager = await open(relative, {
            cwd: firstDir,
            maxEvents: 1,
            maxBytes: 4096,
            onTruncated,
          });
          expect(onTruncated).toHaveBeenCalledOnce();
        } else if (entry === "setSessionTargetAsync") {
          manager = SessionManager.inMemory(firstDir);
          const pending = manager.setSessionTargetAsync(relative);
          process.chdir(secondDir);
          await pending;
        } else if (entry === "openAsync") {
          const pending = SessionManager.openAsync(relative, firstDir);
          process.chdir(secondDir);
          manager = await pending;
        } else if (entry === "setSessionTarget") {
          manager = SessionManager.inMemory(firstDir);
          manager.setSessionTarget(relative);
          process.chdir(secondDir);
        } else {
          manager = SessionManager.open(relative, firstDir);
          process.chdir(secondDir);
        }
        expect(process.cwd()).toBe(secondDir);
        const id = await manager.appendThinkingLevelChange("high");

        expect.soft(manager.getSessionTarget()).toMatchObject({
          ...first,
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        });
        const firstAfter = await loadTranscriptEvents(first);
        expect(firstAfter.slice(0, firstBefore.length)).toEqual(firstBefore);
        expect
          .soft(firstAfter.slice(firstBefore.length))
          .toMatchObject([{ type: "thinking_level_change", id, thinkingLevel: "high" }]);
        expect.soft(await loadTranscriptEvents(second)).toEqual(secondBefore);
      } finally {
        process.chdir(previousCwd);
      }
    });
  },
);
