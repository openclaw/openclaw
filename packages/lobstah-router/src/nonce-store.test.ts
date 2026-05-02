import { beforeEach, describe, expect, it } from "vitest";
import { noteNonce, nonceStoreSize, resetNonceStore } from "./nonce-store.js";

describe("nonce-store", () => {
  beforeEach(() => {
    resetNonceStore();
  });

  it("first sighting of a nonce is fresh", () => {
    expect(noteNonce("aaaa")).toBe("fresh");
    expect(nonceStoreSize()).toBe(1);
  });

  it("second sighting is replay", () => {
    noteNonce("bbbb");
    expect(noteNonce("bbbb")).toBe("replay");
    expect(nonceStoreSize()).toBe(1);
  });

  it("distinct nonces all stored", () => {
    for (let i = 0; i < 5; i++) {
      expect(noteNonce(`nonce-${i}`)).toBe("fresh");
    }
    expect(nonceStoreSize()).toBe(5);
  });

  it("replay after many other nonces is still detected", () => {
    noteNonce("target");
    for (let i = 0; i < 10; i++) noteNonce(`other-${i}`);
    expect(noteNonce("target")).toBe("replay");
  });
});
