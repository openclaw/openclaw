// Qa Lab tests cover shared QA transport contracts.
import { describe, expect, it } from "vitest";
import {
  QA_TRANSPORT_CAPABILITIES,
  QA_TRANSPORT_OPERATIONS,
  createQaTransportCredentialBlockedError,
  createQaTransportUnsupportedOperationError,
  qaTransportNormalizedErrorSchema,
} from "./qa-transport-contracts.js";

describe("qa transport contracts", () => {
  it("keeps capability and operation vocabularies deterministic", () => {
    expect(QA_TRANSPORT_CAPABILITIES).toStrictEqual([...QA_TRANSPORT_CAPABILITIES].toSorted());
    expect(QA_TRANSPORT_OPERATIONS).toStrictEqual([...QA_TRANSPORT_OPERATIONS].toSorted());
    expect(new Set(QA_TRANSPORT_CAPABILITIES).size).toBe(QA_TRANSPORT_CAPABILITIES.length);
    expect(new Set(QA_TRANSPORT_OPERATIONS).size).toBe(QA_TRANSPORT_OPERATIONS.length);
  });

  it("normalizes credential blocking and unsupported operations", () => {
    const credentialError = createQaTransportCredentialBlockedError({
      channelId: "telegram",
      reason: "credential pool exhausted",
      retryable: true,
    });
    const operationError = createQaTransportUnsupportedOperationError({
      operation: "action.edit",
      supportedOperations: ["message.send-inbound", "state.reset"],
      transportId: "crabline",
    });

    expect(qaTransportNormalizedErrorSchema.parse(credentialError.normalized)).toStrictEqual({
      code: "credential_blocked",
      channelId: "telegram",
      reason: "credential pool exhausted",
      retryable: true,
    });
    expect(qaTransportNormalizedErrorSchema.parse(operationError.normalized)).toStrictEqual({
      code: "unsupported_operation",
      operation: "action.edit",
      supportedOperations: ["message.send-inbound", "state.reset"],
      transportId: "crabline",
    });
  });
});
