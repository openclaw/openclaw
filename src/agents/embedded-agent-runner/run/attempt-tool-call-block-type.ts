import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

export type RunnerToolCallBlock = {
  type: "toolCall" | "toolUse" | "functionCall";
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

export function isRunnerToolCallBlock(block: unknown): block is RunnerToolCallBlock {
  const type = asOptionalObjectRecord(block)?.type;
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}
