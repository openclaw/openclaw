import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createTranscriptMirrorTestHarness,
  readMirrorMessages,
} from "./transcript-mirror.test-harness.js";

const { createSqliteMirrorTarget } = createTranscriptMirrorTestHarness();

it("releases fixture validation watchers before removing the database directory", async () => {
  const watch = vi.spyOn(fs, "watch");
  const target = await createSqliteMirrorTarget("openclaw-codex-mirror-cleanup-");
  await readMirrorMessages(target);
  const root = path.dirname(target.storePath);
  const index = watch.mock.calls.findIndex(([directory]) => directory === root);
  expect(index).toBeGreaterThanOrEqual(0);
  const watched = watch.mock.results[index];
  if (!watched || watched.type !== "return") {
    throw new Error("Expected the fixture's validation watcher");
  }
  const close = vi.spyOn(watched.value, "close");
  const remove = fs.rmSync;
  let removed = false;
  vi.spyOn(fs, "rmSync").mockImplementation((directory, options) => {
    if (directory === root) {
      const closed = close.mock.calls.length > 0;
      remove(directory, options);
      removed = true;
      expect(closed).toBe(true);
      return;
    }
    remove(directory, options);
  });
  onTestFinished(() => expect(removed).toBe(true));
});
