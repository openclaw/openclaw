import { describe, expect, it } from "vitest";
import { createAnnounceKey } from "./announce-idempotency.js";

describe("createAnnounceKey", () => {
  it("creates consistent keys for same input", () => {
    const key1 = createAnnounceKey({ sessionKey: "test", runId: "123" });
    const key2 = createAnnounceKey({ sessionKey: "test", runId: "123" });
    expect(key1).toBe(key2);
  });

  it("creates different keys for different inputs", () => {
    const key1 = createAnnounceKey({ sessionKey: "test1", runId: "123" });
    const key2 = createAnnounceKey({ sessionKey: "test2", runId: "123" });
    expect(key1).not.toBe(key2);
  });
});
