import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

const script = fileURLToPath(
  new URL("../skills/knowledge-source-ingest/scripts/chat-transcript.mjs", import.meta.url),
);
const message = (id: any, at: any, author: any, name: any, content: any, extra = {}) => ({
  id,
  occurred_at: at,
  payload: { author_id: author, author_name: name, author_bot: 0, content, ...extra },
});

it("chat transcripts chunk by UTC day, keep threads together and quote cross-day replies", async () => {
  const dir = tempDirs.make("chat-transcript-");

  const rows = [
    message("1", "2026-10-01T23:50:00.000000000Z", "11", "Ann", "ship it?"),
    message("2", "2026-10-02T00:10:00.000000000Z", "12", "Bo", "yes <@11>", {
      reply_to_message_id: "1",
    }),
    message("3", "2026-10-02T00:20:00.000000000Z", "11", "Ann", "plan\u2028step two", {
      thread_id: "t",
      thread_name: "release plan",
    }),
    message("4", "2026-10-02T00:30:00.000000000Z", "12", "Bo", "x".repeat(900)),
  ];
  const input = path.join(dir, "in.jsonl");
  await writeFile(input, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const out = path.join(dir, "out");
  execFileSync(process.execPath, [
    script,
    "--input",
    input,
    "--output-dir",
    out,
    "--channel",
    "#dev",
    "--max-bytes",
    "1000",
  ]);
  const { chunks } = JSON.parse(await readFile(path.join(out, "chunks.json"), "utf8"));
  expect(chunks.map((chunk: any) => [chunk.file, chunk.messages])).toStrictEqual([
    ["2026-10-01.txt", 1],
    ["2026-10-02-part1.txt", 2],
    ["2026-10-02-part2.txt", 1],
  ]);
  const part1 = await readFile(path.join(out, "2026-10-02-part1.txt"), "utf8");
  expect(part1).toMatch(/^00:10 Bo ↩ Ann 2026-10-01 23:50 "ship it\?": yes @Ann$/m);
  const part2 = await readFile(path.join(out, "2026-10-02-part2.txt"), "utf8");
  expect(part2).toMatch(/## Thread: release plan\n00:20 Ann: plan\n {6}step two\n/);
});
