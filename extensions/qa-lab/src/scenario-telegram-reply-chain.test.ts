import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";

it("uses the Telegram reply-chain sender's direct conversation identity", async () => {
  const scenario = readQaScenarioById("telegram-reply-chain-exact-marker");
  const action = scenario.execution.flow?.steps
    .flatMap((step) => step.actions)
    .find((candidate) => isRecord(candidate) && "sendInbound" in candidate);
  const input = isRecord(action) ? action.sendInbound : undefined;
  if (
    !isRecord(input) ||
    !isRecord(input.conversation) ||
    input.conversation.kind !== "direct" ||
    typeof input.conversation.id !== "string" ||
    typeof input.senderId !== "string"
  ) {
    throw new Error("expected a concrete direct-message fixture");
  }
  const adapter = await startOpenClawCrablineAdapter({ channel: "telegram" });
  try {
    const request = adapter.createInbound({
      input: {
        conversation: { id: input.conversation.id, kind: "direct" },
        senderId: input.senderId,
        text: "identity preflight",
      },
    });
    expect(String(request.providerBody.fromId)).toBe(request.providerBody.chatId);
  } finally {
    await adapter.close();
  }
});
