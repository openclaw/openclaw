import { expect, it } from "vitest";
import {
  attachCliMessagingDeliveryEvidence,
  getCliMessagingDeliveryEvidence,
} from "./delivery-evidence.js";

it("preserves delivery evidence for primitive and frozen failures", () => {
  const evidence = { didSendViaMessagingTool: true };
  const primitive = attachCliMessagingDeliveryEvidence("failed", evidence);
  const original = Object.freeze(new Error("frozen"));
  const frozen = attachCliMessagingDeliveryEvidence(original, evidence);

  expect(primitive).toBeInstanceOf(Error);
  expect(frozen).toBe(original);
  expect(getCliMessagingDeliveryEvidence(primitive)?.didSendViaMessagingTool).toBe(true);
  expect(getCliMessagingDeliveryEvidence(frozen)?.didSendViaMessagingTool).toBe(true);
});
