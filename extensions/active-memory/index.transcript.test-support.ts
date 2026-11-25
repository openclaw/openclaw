import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";

export async function expectSingleTranscriptArtifact(directory: string): Promise<string> {
  const files = await fs.readdir(directory);
  expect(files).toEqual([expect.stringMatching(/^active-memory-[a-z0-9]+-[a-f0-9]{8}\.jsonl$/)]);
  return path.join(directory, expectDefined(files[0], "transcript artifact"));
}

export async function writeTranscriptJsonl(sessionFile: string, records: unknown[]) {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

export const memoryToolRecord = (
  toolName: string,
  details: Record<string, unknown>,
  content?: unknown,
) => ({
  message: {
    role: "toolResult",
    toolName,
    details,
    ...(content === undefined ? {} : { content }),
  },
});

export const assistantRecord = (content: unknown) => ({
  message: { role: "assistant", content },
});

export const usableMemoryTranscriptRecord = (text: string) =>
  memoryToolRecord("memory_search", { results: [{ text }] }, [
    { type: "text", text: JSON.stringify({ results: [{ text }] }) },
  ]);

export async function writeUsableMemoryTranscript(sessionFile: string, text: string) {
  await writeTranscriptJsonl(sessionFile, [usableMemoryTranscriptRecord(text)]);
}
