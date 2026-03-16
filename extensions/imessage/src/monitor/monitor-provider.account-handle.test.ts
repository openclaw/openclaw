import { describe, expect, it } from "vitest";
import { validateAccountHandleNotInAllowFrom } from "./monitor-provider.js";

describe("validateAccountHandleNotInAllowFrom", () => {
  it("returns an error when accountHandle appears in config allowFrom", () => {
    const result = validateAccountHandleNotInAllowFrom({
      accountHandle: "+15551234567",
      configAllowFrom: ["+15551234567", "+15559876543"],
      storeAllowFrom: [],
    });
    expect(result).toContain("infinite message loop");
    expect(result).toContain("+15551234567");
  });

  it("returns an error when accountHandle appears in store allowFrom", () => {
    const result = validateAccountHandleNotInAllowFrom({
      accountHandle: "+15551234567",
      configAllowFrom: ["+15559876543"],
      storeAllowFrom: ["+15551234567"],
    });
    expect(result).toContain("infinite message loop");
  });

  it("returns an error when accountHandle matches after normalization (email case)", () => {
    const result = validateAccountHandleNotInAllowFrom({
      accountHandle: "Bot@Example.com",
      configAllowFrom: ["bot@example.com"],
      storeAllowFrom: [],
    });
    expect(result).toContain("infinite message loop");
  });

  it("returns an error when accountHandle matches with service prefix in allowFrom", () => {
    const result = validateAccountHandleNotInAllowFrom({
      accountHandle: "+15551234567",
      configAllowFrom: ["imessage:+15551234567"],
      storeAllowFrom: [],
    });
    expect(result).toContain("infinite message loop");
  });

  it("returns undefined when accountHandle is not in allowFrom", () => {
    const result = validateAccountHandleNotInAllowFrom({
      accountHandle: "+15551234567",
      configAllowFrom: ["+15559876543", "+15550001111"],
      storeAllowFrom: ["+15552223333"],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when accountHandle is omitted", () => {
    const result = validateAccountHandleNotInAllowFrom({
      accountHandle: undefined,
      configAllowFrom: ["+15551234567"],
      storeAllowFrom: ["+15559876543"],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when allowFrom lists are empty", () => {
    const result = validateAccountHandleNotInAllowFrom({
      accountHandle: "+15551234567",
      configAllowFrom: [],
      storeAllowFrom: [],
    });
    expect(result).toBeUndefined();
  });
});
