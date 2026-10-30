import { compareParityBehavior, stableHash } from "./parity-shared.js";
import type { RuntimeParityCell, RuntimeParityDrift } from "./runtime-parity.js";

export type HarnessParityDrift =
  | RuntimeParityDrift
  | "system-prompt"
  | "tool-description"
  | "tool-schema";

export type RuntimeParitySystemPromptReport = {
  systemPrompt?: {
    chars?: number;
    projectContextChars?: number;
    nonProjectContextChars?: number;
    text?: string;
    hash?: string;
    contentHash?: string;
  };
  skills?: {
    promptChars?: number;
    prompt?: string;
    hash?: string;
    contentHash?: string;
  };
  tools?: {
    listChars?: number;
    schemaChars?: number;
    entries?: Array<{
      name?: string;
      summary?: string;
      summaryHash?: string;
      summaryChars?: number;
      schema?: unknown;
      schemaHash?: string;
      schemaChars?: number;
      propertiesCount?: number;
    }>;
  };
};

export type HarnessRuntimeParityCell = RuntimeParityCell & {
  systemPromptReport?: RuntimeParitySystemPromptReport;
};

function harnessSurfaceHashes(cell: HarnessRuntimeParityCell) {
  const report = cell.systemPromptReport;
  const toolEntries = report?.tools?.entries ?? [];
  return {
    systemPromptHash: stableHash({
      systemPrompt: report?.systemPrompt ?? null,
      skills: report?.skills ?? null,
    }),
    toolDescriptionHash: stableHash(
      toolEntries.map((entry) => ({
        name: entry.name,
        summary: entry.summary,
        summaryHash: entry.summaryHash,
        summaryChars: entry.summaryChars,
      })),
    ),
    toolSchemaHash: stableHash({
      listChars: report?.tools?.listChars,
      schemaChars: report?.tools?.schemaChars,
      entries: toolEntries.map((entry) => ({
        name: entry.name,
        schema: entry.schema,
        schemaHash: entry.schemaHash,
        schemaChars: entry.schemaChars,
        propertiesCount: entry.propertiesCount,
      })),
    }),
  };
}

export function classifyHarnessParityDrift(params: {
  left: HarnessRuntimeParityCell;
  right: HarnessRuntimeParityCell;
}): HarnessParityDrift {
  if (
    params.left.transportErrorClass ||
    params.right.transportErrorClass ||
    params.left.runtimeErrorClass ||
    params.right.runtimeErrorClass
  ) {
    return "failure-mode";
  }
  const left = harnessSurfaceHashes(params.left);
  const right = harnessSurfaceHashes(params.right);
  if (left.systemPromptHash !== right.systemPromptHash) {
    return "system-prompt";
  }
  if (left.toolDescriptionHash !== right.toolDescriptionHash) {
    return "tool-description";
  }
  if (left.toolSchemaHash !== right.toolSchemaHash) {
    return "tool-schema";
  }
  return compareParityBehavior({
    left: params.left,
    right: params.right,
    transcriptMode: "messages",
  }).drift;
}
