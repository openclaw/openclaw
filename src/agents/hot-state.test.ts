import { describe, expect, it } from "vitest";
import {
  buildHotState,
  enforceHotStateTokenCap,
  formatHotStateJson,
  HotStateSchema,
} from "./hot-state.js";

describe("HotState", () => {
  it("validates strict JSON shape", () => {
    const parsed = HotStateSchema.parse({
      session_id: "s1",
      objective: "ship",
      risk_level: "low",
    });
    expect(parsed.session_id).toBe("s1");
  });

  it("formats as JSON only", () => {
    const hs = buildHotState({ session_id: "s1", risk_level: "medium" });
    const json = formatHotStateJson(hs);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.trim().startsWith("{")).toBe(true);
  });

  it("enforces token cap via minimal fallback", () => {
    const big = buildHotState({
      session_id: "s1",
      // artificially large fields
      constraints: Array.from({ length: 500 }, (_, i) => `C${i}-${"x".repeat(40)}`),
      open_questions: Array.from({ length: 500 }, (_, i) => `Q${i}-${"y".repeat(40)}`),
      accepted_decisions: Array.from({ length: 500 }, (_, i) => `D${i}-${"z".repeat(40)}`),
      risk_level: "high",
    });

    const capped = enforceHotStateTokenCap({ hotState: big, maxTokens: 50 });
    expect(capped.wasTruncated).toBe(true);
    expect(capped.tokens).toBeLessThanOrEqual(50);

    const parsed = JSON.parse(capped.json) as Record<string, unknown>;
    expect(parsed.session_id).toBe("s1");
  });

  it("includes artifact_index when provided", () => {
    const hs = buildHotState({
      session_id: "s1",
      artifact_index: [
        { artifact_id: "abc123", type: "doc", label: "spec.md", version: "v1" },
        { artifact_id: "def456", type: "code", label: "main.ts" },
      ],
    });

    expect(hs.artifact_index).toHaveLength(2);
    expect(hs.artifact_index?.[0]?.artifact_id).toBe("abc123");
    expect(hs.artifact_index?.[0]?.type).toBe("doc");
  });

  it("validates artifact_index entries strictly", () => {
    expect(() =>
      buildHotState({
        session_id: "s1",
        artifact_index: [
          // @ts-expect-error testing invalid type
          { artifact_id: "xyz", type: "invalid" },
        ],
      }),
    ).toThrow();
  });
});
