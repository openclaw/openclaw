import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";

export async function expectSingleTranscriptArtifact(directory: string): Promise<string> {
  const files = await fs.readdir(directory);
  expect(files).toEqual([expect.stringMatching(/^active-memory-[a-z0-9]+-[a-f0-9]{8}\.jsonl$/)]);
  return path.join(directory, expectDefined(files[0], "transcript artifact"));
}

export const writeTranscriptJsonl = async (sessionFile: string, records: unknown[]) => {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
};
