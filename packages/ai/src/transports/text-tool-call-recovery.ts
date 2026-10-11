export type RecoveredTextToolCall = {
  kind: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
  partialArgs: string;
};

export type TextToolCallRecoveryPart = { kind: "text"; text: string } | RecoveredTextToolCall;
