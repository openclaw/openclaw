import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markFailed, MAX_CONSECUTIVE_FAILURES, resetPeerState } from "./peer-state.js";
import type { Peer } from "./peers.js";
import { candidatesForModel, orderCandidates, resetCursor } from "./pick.js";

const peer = (suffix: string, label?: string): Peer => ({
  pubkey: `lob1${suffix.padStart(64, "0")}`.slice(0, 68),
  url: `http://example.invalid/${suffix}`,
  label,
});

const capFor = (models: string[]) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ pubkey: "lob1x", models, queueDepth: 0 }),
  } as unknown as Response);

describe("candidatesForModel", () => {
  beforeEach(() => {
    resetPeerState();
    resetCursor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes only peers whose capacity reports the model", async () => {
    const a = peer("a");
    const b = peer("b");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: ["llama3.1:8b"] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: ["qwen2.5:7b"] }) });
    vi.stubGlobal("fetch", fetchMock);
    const out = await candidatesForModel([a, b], "llama3.1:8b");
    expect(out).toEqual([a]);
  });

  it("excludes unhealthy peers without re-fetching capacity", async () => {
    const a = peer("a");
    const b = peer("b");
    const fetchMock = capFor(["llama3.1:8b"]);
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) markFailed(a.pubkey);
    const out = await candidatesForModel([a, b], "llama3.1:8b");
    expect(out).toEqual([b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty when no peer has the model", async () => {
    const a = peer("a");
    vi.stubGlobal("fetch", capFor(["something-else"]));
    const out = await candidatesForModel([a], "llama3.1:8b");
    expect(out).toEqual([]);
  });
});

describe("orderCandidates", () => {
  beforeEach(() => {
    resetCursor();
  });

  it("returns candidates unchanged when 0 or 1", () => {
    expect(orderCandidates([])).toEqual([]);
    const a = peer("a");
    expect(orderCandidates([a])).toEqual([a]);
  });

  it("rotates start position across calls (round-robin)", () => {
    const a = peer("a");
    const b = peer("b");
    const c = peer("c");
    const list = [a, b, c];
    const r0 = orderCandidates(list);
    const r1 = orderCandidates(list);
    const r2 = orderCandidates(list);
    expect(r0[0]).toBe(a);
    expect(r1[0]).toBe(b);
    expect(r2[0]).toBe(c);
  });

  it("preserves the candidate set (just rotates)", () => {
    const list = [peer("a"), peer("b"), peer("c")];
    const sorted = (xs: Peer[]) => [...xs].sort((x, y) => x.pubkey.localeCompare(y.pubkey));
    expect(sorted(orderCandidates(list))).toEqual(sorted(list));
  });
});
