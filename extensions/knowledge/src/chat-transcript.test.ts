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

it("orders mixed timestamp precision without losing nanoseconds or the ID tie-break", async () => {
  const out = tempDirs.make("chat-transcript-precision-");
  const rows = [
    ["40", "Z"],
    ["10", ".000Z"],
    ["30", ".1Z"],
    ["20", ".100000000Z"],
    ["01", ".100000001Z"],
  ].map(([id, suffix]) => message(id, "2026-11-08T10:00:00" + suffix, "1", "Ann", "message-" + id));
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
  const expected = [1, 0, 3, 2, 4].map((index) => rows[index]!);
  const raw = (await readFile(path.join(out, "2026-11-08.jsonl"), "utf8")).trim().split("\n");
  expect(raw.map((line) => JSON.parse(line))).toEqual(expected);
  const text = await readFile(path.join(out, "2026-11-08.txt"), "utf8");
  expect(text.split("\n").filter((line) => line.startsWith("10:00 Ann:"))).toEqual(
    expected.map((row) => "10:00 Ann: " + row.payload.content),
  );
  const { chunks } = JSON.parse(await readFile(path.join(out, "chunks.json"), "utf8"));
  expect(chunks[0]).toMatchObject({ first_message_id: "10", last_message_id: "01" });
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
