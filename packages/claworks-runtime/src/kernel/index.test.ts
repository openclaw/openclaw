import { describe, expect, it } from "vitest";
import { createIngressRouter, DEFAULT_INGRESS_POLICIES } from "./index.js";

describe("@claworks/runtime/kernel", () => {
  it("re-exports ingress router from package kernel", () => {
    const router = createIngressRouter(DEFAULT_INGRESS_POLICIES);
    expect(router.decide("im", "im.message.received", "feishu:u1").action).toBe("intent_route");
  });
});
