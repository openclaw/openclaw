// Shared Active Memory fixtures and assertions for index plugin tests.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { expect, vi } from "vitest";

/** Turn authority that denies every tool, so Active Memory records `policy-disabled`. */
export const deniedMemoryToolAuthority = {
  fingerprint: "denied-memory-authority",
  allows: () => false,
  assertActive: () => undefined,
};

/** Search manager whose lane-one trigger lookup returns one strong "booking a flight" hit. */
export function createStrongTriggerHitManager() {
  return {
    manager: {
      search: vi.fn(async () => []),
      listTriggerCandidates: vi.fn(async () => [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "Prefer aisle seats.",
          source: "memory" as const,
          provenance: {
            originClass: "agent" as const,
            sessionKind: "interactive" as const,
            observedAt: 1,
          },
          triggers: "booking a flight",
        },
      ]),
    },
  } as never;
}

// Match only lone surrogates so valid supplementary-plane characters remain allowed.
export const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export async function expectSingleTranscriptArtifact(directory: string): Promise<string> {
  const files = await fs.readdir(directory);
  expect(files).toEqual([expect.stringMatching(/^active-memory-[a-z0-9]+-[a-f0-9]{8}\.jsonl$/)]);
  return path.join(directory, expectDefined(files[0], "transcript artifact"));
}

export const expectLinesToContain = (lines: string[], text: string) => {
  expect(lines.join("\n")).toContain(text);
};
export const expectLinesNotToContain = (lines: string[], text: string) => {
  expect(lines.join("\n")).not.toContain(text);
};
export const writeTranscriptJsonl = async (sessionFile: string, records: unknown[]) => {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
};
export const usableMemoryTranscriptRecord = (text: string) => ({
  message: {
    role: "toolResult",
    toolName: "memory_search",
    details: { results: [{ text }] },
    content: [{ type: "text", text: JSON.stringify({ results: [{ text }] }) }],
  },
});
export const writeUsableMemoryTranscript = async (sessionFile: string, text: string) => {
  await writeTranscriptJsonl(sessionFile, [usableMemoryTranscriptRecord(text)]);
};
export const waitForAbort = async (abortSignal?: AbortSignal): Promise<never> => {
  if (abortSignal?.aborted) {
    throw toLintErrorObject(
      (abortSignal.reason as unknown) ?? new Error("Operation aborted"),
      "Non-Error thrown",
    );
  }
  return await new Promise<never>((_resolve, reject) => {
    abortSignal?.addEventListener(
      "abort",
      () => {
        reject(
          toLintErrorObject(
            (abortSignal.reason as unknown) ?? new Error("Operation aborted"),
            "Non-Error rejection",
          ),
        );
      },
      { once: true },
    );
  });
};
export const makeMemoryToolAllowlistError = (
  reason: string,
  sources = "runtime toolsAllow: memory_search, memory_get",
) =>
  new Error(
    `No callable tools remain after resolving explicit tool allowlist ` +
      `(${sources}); ${reason}. ` +
      `Fix the allowlist or enable the plugin that registers the requested tool.`,
  );
export const requireRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
};
export const requireNonEmptyString = (value: unknown, message: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
};
