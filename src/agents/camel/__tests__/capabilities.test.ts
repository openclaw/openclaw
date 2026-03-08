import { describe, expect, it } from "vitest";
import { createCapabilities, mergeCapabilities } from "../capabilities.js";
import { SourceKind } from "../types.js";

describe("camel/capabilities", () => {
  it("merges sources from multiple parents", () => {
    const a = createCapabilities({ sources: [SourceKind.User] });
    const b = createCapabilities({ sources: [{ kind: "tool", toolName: "web_fetch" }] });

    const merged = mergeCapabilities(a, b);
    expect(Array.from(merged.sources)).toEqual(
      expect.arrayContaining([SourceKind.User, { kind: "tool", toolName: "web_fetch" }]),
    );
  });

  it("intersects restricted readers", () => {
    const a = createCapabilities({
      readers: { kind: "restricted", allowedReaders: new Set(["alice", "bob"]) },
    });
    const b = createCapabilities({
      readers: { kind: "restricted", allowedReaders: new Set(["bob", "carol"]) },
    });

    const merged = mergeCapabilities(a, b);
    expect(merged.readers.kind).toBe("restricted");
    if (merged.readers.kind === "restricted") {
      expect(Array.from(merged.readers.allowedReaders)).toEqual(["bob"]);
    }
  });
});
