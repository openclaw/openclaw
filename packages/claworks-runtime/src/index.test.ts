import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGRESS_POLICIES,
  createIngressRouter,
  DEFAULT_RBAC_POLICIES,
  createRbacGuard,
} from "./index.js";

describe("@claworks/runtime barrel", () => {
  it("re-exports ingress defaults", () => {
    const router = createIngressRouter(DEFAULT_INGRESS_POLICIES);
    const decision = router.decide("im", "im.message.received", "feishu:u1");
    expect(decision.action).toBe("intent_route");
  });

  it("re-exports rbac guard", () => {
    const guard = createRbacGuard([...DEFAULT_RBAC_POLICIES]);
    expect(
      guard.check({
        action: "event.publish",
        resource: "alarm.created",
        subjectType: "system",
        subjectId: "connector",
      }).allowed,
    ).toBe(true);
  });
});
