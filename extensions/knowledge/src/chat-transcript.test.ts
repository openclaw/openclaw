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

it("keeps day/thread boundaries and replies while budgeting UTF-8 headers and part labels", async () => {
  const out = tempDirs.make("chat-transcript-");
  const at = "2026-10-02T00:30:00Z";
  const rows = [
    message("1", "2026-10-01T23:50:00.000000000Z", "11", "Ann", "ship it?"),
    message("2", "2026-10-02T00:10:00.000000000Z", "12", "Bo", "yes <@11>", {
      reply_to_message_id: "1",
    }),
    message("3", "2026-10-02T00:20:00.000000000Z", "11", "Ann", "plan\u2028step two", {
      thread_id: "t",
      thread_name: "release plan",
    }),
    ...Array.from({ length: 3 }, (_, i) =>
      message(String(i + 4), at, "u" + i, "开发者🦀 " + i, "x".repeat(250)),
    ),
  ];
  await writeFile(
    path.join(out, "in.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const args = [script, "--input", path.join(out, "in.jsonl"), "--output-dir", out];
  execFileSync(process.execPath, [...args, "--channel", "#dev", "--max-bytes", "1000"]);
  const { chunks } = JSON.parse(await readFile(path.join(out, "chunks.json"), "utf8"));
  expect(chunks.map((chunk: any) => [chunk.file, chunk.messages])).toStrictEqual([
    ["2026-10-01.txt", 1],
    ["2026-10-02-part1.txt", 3],
    ["2026-10-02-part2.txt", 2],
  ]);
  const read = (chunk: { file: string }) => readFile(path.join(out, chunk.file));
  const texts = await Promise.all(chunks.map(read));
  expect(texts[1].toString()).toMatch(/^00:10 Bo ↩ Ann 2026-10-01 23:50 "ship it\?": yes @Ann$/m);
  expect(texts[2].toString()).toMatch(/## Thread: release plan\n00:20 Ann: plan\n {6}step two\n/);
  for (const [i, chunk] of chunks.entries()) {
    expect(chunk.bytes).toBe(texts[i].length);
    expect(texts[i].length).toBeLessThanOrEqual(1000);
    const label = `part ${chunk.part} of ${chunk.parts}`;
    expect(texts[i].includes(label)).toBe(chunk.parts > 1);
  }
});

it("caps a cross-day reply preview without cutting an emoji in half", async () => {
  const out = tempDirs.make("chat-transcript-");
  const rows = [
    message("1", "2026-10-01T23:59:00Z", "11", "Ann", "a".repeat(79) + "😀"),
    message("2", "2026-10-02T00:10:00Z", "12", "Bo", "ack", { reply_to_message_id: "1" }),
  ];
  const input = path.join(out, "in.jsonl");
  await writeFile(input, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  execFileSync(process.execPath, [
    script,
    "--input",
    input,
    "--output-dir",
    out,
    "--channel",
    "#dev",
  ]);
  expect(await readFile(path.join(out, "2026-10-02.txt"), "utf8")).toMatch(/"a{79}"/);
});
