import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "./session-manager.js";

it.each([
  { entry: "open", storePath: "session-store.sqlite", linked: false },
  { entry: "open", storePath: "sessions.json", linked: false },
  { entry: "open", storePath: "custom-store.json", linked: false },
  { entry: "open", storePath: "linked/session-store.sqlite", linked: true },
  { entry: "openBounded", storePath: "session-store.sqlite", linked: false },
  { entry: "setSessionTarget", storePath: "session-store.sqlite", linked: false },
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
        if (entry === "openBounded") {
          manager = SessionManager.openBounded(relative, {
            cwd: firstDir,
            maxEvents: 1,
            maxBytes: 4096,
            onTruncated,
          });
          expect(onTruncated).toHaveBeenCalledOnce();
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

        expect.soft(manager.getSessionTarget()).toEqual(first);
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
