import { describe, expect, it } from "vitest";
import {
  MEMORY_RECALL_CONTEXT_NAME,
  MEMORY_RECALL_MAX_BYTES,
  appGroupIdFromUserId,
  appendMemoryRecallBootstrapFile,
  buildMemoryRecallContextFile,
  clampMemoryRecall,
  type FactSearcher,
} from "./memory-recall-context.ts";

const base = [{ name: "AGENTS.md", path: "/w/AGENTS.md", content: "a", missing: false }] as never[];
const appKey = "agent:main:app:havaya:user_xyz:2db59c18-3029-4165-83fb-a4c94d4df05f";

// Independent re-implementation of the life-memory-scope hook's sanitize, to assert parity.
const hookGroupId = (id: string): string =>
  "app_" +
  String(id)
    .trim()
    .toLowerCase()
    .replace(/[^A-Za-z0-9_]/g, "_");

describe("appGroupIdFromUserId (parity with life-memory-scope hook)", () => {
  it("matches the hook for a plain id", () => {
    expect(appGroupIdFromUserId("user_abc123")).toBe(hookGroupId("user_abc123"));
  });
  it("collapses dashes to underscores like the hook", () => {
    expect(appGroupIdFromUserId("user_abc-123")).toBe("app_user_abc_123");
    expect(appGroupIdFromUserId("user_abc-123")).toBe(hookGroupId("user_abc-123"));
  });
});

describe("clampMemoryRecall", () => {
  it("leaves within-cap content unchanged", () => {
    expect(clampMemoryRecall("- a fact")).toBe("- a fact");
  });
  it("bounds oversize content on a UTF-8 boundary", () => {
    const clamped = clampMemoryRecall("你".repeat(2000));
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(MEMORY_RECALL_MAX_BYTES);
    expect(clamped.endsWith("�")).toBe(false);
  });
});

describe("buildMemoryRecallContextFile", () => {
  it("builds MEMORY_RECALL.md with bulleted facts", () => {
    const f = buildMemoryRecallContextFile(["goal: write daily", "lives in TLV"]);
    expect(f?.name).toBe(MEMORY_RECALL_CONTEXT_NAME);
    expect(f?.path).toBe(MEMORY_RECALL_CONTEXT_NAME); // bare name, no users/<id> leak
    expect(f?.content).toContain("- goal: write daily");
    expect(f?.content).toContain("- lives in TLV");
    expect(f?.missing).toBe(false);
  });
  it("returns null when there are no usable facts", () => {
    expect(buildMemoryRecallContextFile([])).toBeNull();
    expect(buildMemoryRecallContextFile(["  ", ""])).toBeNull();
  });
  it("clamps an oversize fact list", () => {
    const many = Array.from({ length: 500 }, (_, i) => `x`.repeat(20) + i);
    const f = buildMemoryRecallContextFile(many);
    expect(Buffer.byteLength(f?.content ?? "", "utf8")).toBeLessThanOrEqual(
      MEMORY_RECALL_MAX_BYTES,
    );
  });
});

describe("appendMemoryRecallBootstrapFile", () => {
  it("is a no-op for a telegram session (never searches)", async () => {
    let called = false;
    const search: FactSearcher = async () => {
      called = true;
      return ["x"];
    };
    const out = await appendMemoryRecallBootstrapFile(base, {
      sessionKey: "agent:main:telegram:acct:direct:123",
      searchFacts: search,
    });
    expect(out).toBe(base);
    expect(called).toBe(false);
  });

  it("is a no-op when there is no session key", async () => {
    const out = await appendMemoryRecallBootstrapFile(base, { searchFacts: async () => ["x"] });
    expect(out).toBe(base);
  });

  it("injects MEMORY_RECALL.md for an app session, scoped to the right group id", async () => {
    let seen: { groupId?: string } = {};
    const out = await appendMemoryRecallBootstrapFile(base, {
      sessionKey: appKey,
      searchFacts: async (p) => {
        seen = p;
        return ["goal: build a daily writing routine"];
      },
    });
    expect(seen.groupId).toBe("app_user_xyz");
    expect(out.length).toBe(base.length + 1);
    expect(out[out.length - 1]?.name).toBe(MEMORY_RECALL_CONTEXT_NAME);
    expect(out[out.length - 1]?.content).toContain("daily writing routine");
  });

  it("is a no-op when the graph has no facts", async () => {
    const out = await appendMemoryRecallBootstrapFile(base, {
      sessionKey: appKey,
      searchFacts: async () => [],
    });
    expect(out).toBe(base);
  });

  it("fails OPEN when the searcher throws (files unchanged)", async () => {
    const out = await appendMemoryRecallBootstrapFile(base, {
      sessionKey: appKey,
      searchFacts: async () => {
        throw new Error("graphiti down");
      },
    });
    expect(out).toBe(base);
  });

  it("queries fresh every turn — no cross-turn cache that could serve stale recall after a write", async () => {
    let calls = 0;
    const results: string[][] = [[], ["goal just saved this turn"]];
    const search: FactSearcher = async () => results[calls++] ?? [];
    const out1 = await appendMemoryRecallBootstrapFile(base, {
      sessionKey: appKey,
      searchFacts: search,
    });
    expect(out1).toBe(base); // turn 1: empty graph
    const out2 = await appendMemoryRecallBootstrapFile(base, {
      sessionKey: appKey,
      searchFacts: search,
    });
    expect(calls).toBe(2); // searched again, not served a cached empty result
    expect(out2[out2.length - 1]?.content).toContain("goal just saved this turn");
  });
});
