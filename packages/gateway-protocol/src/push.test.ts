// Gateway Protocol tests cover push behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { PushTestParamsSchema, PushTestResultSchema } from "./schema/push.js";

describe("push destination request", () => {
  const validate = Compile(PushTestParamsSchema);

  it("accepts an optional session without allowing a caller-selected Gateway", () => {
    expect(validate.Check({ nodeId: "ios-node", sessionKey: "agent:main:incident" })).toBe(true);
    expect(validate.Check({ nodeId: "ios-node" })).toBe(true);
    expect(validate.Check({ nodeId: "ios-node", sessionKey: "" })).toBe(false);
    expect(validate.Check({ nodeId: "ios-node", sessionKey: 42 })).toBe(false);
    expect(validate.Check({ nodeId: "ios-node", gatewayDeviceId: "forged" })).toBe(false);
  });
});

/**
 * Push protocol schema regression for APNS test results.
 * The transport field tells operators whether delivery used direct APNS or the
 * relay path, so it is part of the public result contract.
 */
describe("gateway protocol push schema", () => {
  const validatePushTestResult = Compile(PushTestResultSchema);

  it("accepts push.test results with a transport", () => {
    expect(
      validatePushTestResult.Check({
        ok: true,
        status: 200,
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "relay",
      }),
    ).toBe(true);
  });
});
