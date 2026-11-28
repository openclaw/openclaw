import { expect, it } from "vitest";
import { buildTurnDeliveryContextFragments } from "./turn-delivery-context.js";

it.each([false, true])(
  "describes automatic source delivery only for ordinary turns (private=%s)",
  (privateCompletion) => {
    const fragments = buildTurnDeliveryContextFragments({
      config: { messages: { visibleReplies: "message_tool" } },
      sourceReplyDeliveryMode: "automatic",
      privateCompletion,
    });
    const guidance = fragments.map((fragment) => fragment.text).join("\n");
    const automaticDelivery = "This turn's final text goes to the current source automatically.";
    if (privateCompletion) {
      expect(guidance).not.toContain(automaticDelivery);
    } else {
      expect(guidance).toContain(automaticDelivery);
    }
  },
);
