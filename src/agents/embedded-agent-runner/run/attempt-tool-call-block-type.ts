import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

export function isRunnerToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

export type RunnerToolCallBlock = {
  type: "toolCall" | "toolUse" | "functionCall";
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

export function isRunnerToolCallBlock(block: unknown): block is RunnerToolCallBlock {
  return isRunnerToolCallBlockType(asOptionalObjectRecord(block)?.type);
}
