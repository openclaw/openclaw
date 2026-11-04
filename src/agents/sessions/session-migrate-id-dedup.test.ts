import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openFileBackedSessionManagerForTest } from "../../../test/helpers/session-manager-file-fixture.js";

const { uuidQueue } = vi.hoisted(() => ({ uuidQueue: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () =>
      (uuidQueue.shift() ??
        actual.randomUUID()) as `${string}-${string}-${string}-${string}-${string}`,
  };
});

const message = (content: string, role = "user", second = 1) => ({
  type: "message",
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  message: { role, content },
});

function writeV1File(entries: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "oc-v1mig-"));
  const file = join(dir, "session.jsonl");
  const header = {
    type: "session",
    version: 1,
    id: "v1-header-id",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/cwd",
  };
  writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { file, sm: openFileBackedSessionManagerForTest(file, dir) };
}

it("assigns full v1 entry ids while preserving parent linkage", () => {
  const firstId = "deadbeef-0000-4000-8000-000000000000";
  const secondId = "deadbeef-0000-4000-8000-000000000001";
  uuidQueue.length = 0;
  uuidQueue.push(firstId, secondId);

  const { sm } = writeV1File([message("first"), message("second", "assistant", 2)]);

  const messages = sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map(({ id, parentId }) => ({ id, parentId }));

  expect(messages).toEqual([
    { id: firstId, parentId: null },
    { id: secondId, parentId: firstId },
  ]);
});

it("preserves v1 compaction indexes across opaque rows", () => {
  const { file, sm } = writeV1File([
    message("prelude"),
    null,
    message("kept", "user", 2),
    {
      type: "compaction",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "summary",
      firstKeptEntryIndex: 3,
      tokensBefore: 200,
    },
  ]);
  const kept = sm
    .getEntries()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "kept",
    );
  const compaction = sm.getEntries().find((entry) => entry.type === "compaction");

  expect(kept).toBeDefined();
  expect(compaction).toMatchObject({ firstKeptEntryId: kept?.id });
  expect(readFileSync(file, "utf8").split("\n")).toContain("null");
});
