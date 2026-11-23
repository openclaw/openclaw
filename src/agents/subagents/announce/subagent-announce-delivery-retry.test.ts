import { describe, expect, it } from "vitest";
import { GatewayClientRequestError } from "../../../../packages/gateway-client/src/request-error.js";
import { isPermanentAnnounceDeliveryError } from "./subagent-announce-delivery-retry.js";

describe("isPermanentAnnounceDeliveryError", () => {
  it("stops on a Gateway refusal and retries an unavailable Gateway", () => {
    const refused = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "completion handoff refused",
    });
    expect(isPermanentAnnounceDeliveryError(refused)).toBe(true);
    expect(isPermanentAnnounceDeliveryError(new Error("handoff failed", { cause: refused }))).toBe(
      true,
    );
    expect(
      isPermanentAnnounceDeliveryError(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "gateway draining",
          retryable: true,
        }),
      ),
    ).toBe(false);
  });
});
