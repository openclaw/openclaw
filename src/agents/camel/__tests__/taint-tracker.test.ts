import { describe, expect, it } from "vitest";
import { TaintTracker } from "../taint-tracker.js";
import { deriveValue, isTainted } from "../value.js";

describe("camel/taint-tracker", () => {
  it("marks untrusted tool output as tainted", () => {
    const tracker = new TaintTracker();
    const wrapped = tracker.wrapToolResult("web_fetch", "payload");

    expect(isTainted(wrapped)).toBe(true);
  });

  it("keeps trusted tool output untainted", () => {
    const tracker = new TaintTracker({ trustedTools: ["session_status"] });
    const wrapped = tracker.wrapToolResult("session_status", { ok: true });

    expect(isTainted(wrapped)).toBe(false);
  });

  it("propagates taint in dependency chain", () => {
    const tracker = new TaintTracker();
    const source = tracker.wrapToolResult("web_fetch", "extract me");
    const extracted = deriveValue("attacker@evil.com", source);

    expect(isTainted(extracted)).toBe(true);
  });

  it("does not trust spoofed camel values", () => {
    const tracker = new TaintTracker();
    const spoofed = {
      raw: "malicious",
      capabilities: { sources: new Set(["user"]), readers: { kind: "public" } },
      dependencies: [],
    };

    const wrapped = tracker.wrapArgs("message.send", { body: spoofed }).body;
    expect(wrapped.raw).toEqual(spoofed);
  });
});
