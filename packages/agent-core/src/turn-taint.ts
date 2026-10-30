import type { AssistantMessage, ToolResultMessage } from "@openclaw/llm-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage, ToolResultContentSource } from "./types.js";

type TurnTaintMetadata = {
  resultContentSource?: ToolResultContentSource;
  turnTainted?: true;
};

function readTurnTaintMetadata(message: AgentMessage): TurnTaintMetadata | undefined {
  const metadata = Reflect.get(message, "__openclaw");
  const record = asOptionalRecord(metadata);
  if (!record) {
    return undefined;
  }
  return {
    ...(record.resultContentSource === "network"
      ? { resultContentSource: record.resultContentSource }
      : {}),
    ...(record.turnTainted === true ? { turnTainted: true } : {}),
  };
}

export function toolResultTaintsTurn(message: ToolResultMessage): boolean {
  return readTurnTaintMetadata(message)?.resultContentSource === "network";
}

export function isActiveTurnTainted(messages: readonly AgentMessage[]): boolean {
  const boundary = messages.findLast((message) => {
    if (message.role === "user") {
      return true;
    }
    const metadata = readTurnTaintMetadata(message);
    return metadata?.turnTainted === true || metadata?.resultContentSource === "network";
  });
  return boundary !== undefined && boundary.role !== "user";
}

export function withAssistantTurnTaint(
  message: AssistantMessage,
  tainted: boolean,
): AssistantMessage {
  if (!tainted) {
    return message;
  }
  const taintedMessage = {
    ...message,
    __openclaw: { ...readTurnTaintMetadata(message), turnTainted: true },
  } satisfies AssistantMessage & { __openclaw: TurnTaintMetadata };
  return taintedMessage;
}

export function withToolResultContentSource(
  message: ToolResultMessage,
  source: ToolResultContentSource | undefined,
): ToolResultMessage {
  if (!source) {
    return message;
  }
  const sourcedMessage = {
    ...message,
    __openclaw: { ...readTurnTaintMetadata(message), resultContentSource: source },
  } satisfies ToolResultMessage & { __openclaw: TurnTaintMetadata };
  return sourcedMessage;
}
