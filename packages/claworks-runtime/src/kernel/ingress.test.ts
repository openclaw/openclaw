import { describe, expect, it } from "vitest";
import { createIngressRouter, DEFAULT_INGRESS_POLICIES } from "./ingress.js";

describe("IngressRouter", () => {
  const router = createIngressRouter(DEFAULT_INGRESS_POLICIES);

  it("routes connector events to kernel", () => {
    const decision = router.decide("connector", "alarm.created");
    expect(decision.action).toBe("kernel");
  });

  it("routes REST events to kernel", () => {
    const decision = router.decide("rest", "workorder.created");
    expect(decision.action).toBe("kernel");
  });

  it("routes scheduler to kernel", () => {
    const decision = router.decide("scheduler", "daily.report");
    expect(decision.action).toBe("kernel");
  });

  it("routes IM messages to intent_route", () => {
    const decision = router.decide("im", "user.message");
    expect(decision.action).toBe("intent_route");
    if (decision.action === "intent_route") {
      expect(decision.hint).toBe("classify_im_to_business_event");
    }
  });

  it("routes webhook to intent_route by default", () => {
    const decision = router.decide("webhook", "raw.webhook");
    expect(decision.action).toBe("intent_route");
  });

  it("reloads policies and changes routing", () => {
    const r = createIngressRouter([]);
    // no policies → observe_only
    expect(r.decide("connector", "alarm.created").action).toBe("observe_only");

    r.reload([
      {
        id: "test-connector-kernel",
        source: "connector",
        eventTypePattern: "*",
        decision: { action: "kernel" },
        priority: 100,
      },
    ]);
    expect(r.decide("connector", "alarm.created").action).toBe("kernel");
  });
});
