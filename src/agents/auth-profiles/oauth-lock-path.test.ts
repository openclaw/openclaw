import { describe, expect, it } from "vitest";
import { resolveOAuthRefreshLockKey } from "./paths.js";

describe("resolveOAuthRefreshLockKey", () => {
  it("hashes dot-segment ids into bounded SQLite keys", () => {
    const dotSegmentKey = resolveOAuthRefreshLockKey("openai-codex", "..");
    const currentDirKey = resolveOAuthRefreshLockKey("openai-codex", ".");

    expect(dotSegmentKey).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(currentDirKey).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(dotSegmentKey).not.toBe(currentDirKey);
  });

  it("hashes profile ids so distinct values stay distinct", () => {
    expect(resolveOAuthRefreshLockKey("openai-codex", "openai-codex:work/test")).not.toBe(
      resolveOAuthRefreshLockKey("openai-codex", "openai-codex_work:test"),
    );
    expect(resolveOAuthRefreshLockKey("openai-codex", "«c")).not.toBe(
      resolveOAuthRefreshLockKey("openai-codex", "઼"),
    );
  });

  it("hashes distinct providers to distinct keys for the same profileId", () => {
    expect(resolveOAuthRefreshLockKey("openai-codex", "shared:default")).not.toBe(
      resolveOAuthRefreshLockKey("anthropic", "shared:default"),
    );
  });

  it("is immune to simple concat collisions at the provider/profile boundary", () => {
    expect(resolveOAuthRefreshLockKey("a", "b:c")).not.toBe(resolveOAuthRefreshLockKey("a:b", "c"));
  });

  it("keeps lock keys short for long profile ids", () => {
    const longProfileId = `openai-codex:${"x".repeat(512)}`;
    const key = resolveOAuthRefreshLockKey("openai-codex", longProfileId);

    expect(key).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(Buffer.byteLength(key, "utf8")).toBeLessThan(255);
  });

  it("is deterministic: same (provider, profileId) produces the same key", () => {
    const first = resolveOAuthRefreshLockKey("openai-codex", "openai-codex:default");
    const second = resolveOAuthRefreshLockKey("openai-codex", "openai-codex:default");
    expect(first).toBe(second);
  });

  it("never embeds path separators or dot segments", () => {
    const hazards = [
      ["openai-codex", "../etc/passwd"],
      ["openai-codex", "../../../../secrets"],
      ["openai-codex", "openai\\codex"],
      ["openai-codex", "openai/codex/default"],
      ["openai-codex", "profile\x00with-null"],
      ["openai-codex", "profile\nwith-newline"],
      ["openai-codex", "profile with spaces"],
      ["../../etc", "passwd"],
      ["provider\x00with-null", "default"],
    ] as const;
    for (const [provider, id] of hazards) {
      const key = resolveOAuthRefreshLockKey(provider, id);
      expect(key).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(key).not.toContain("/");
      expect(key).not.toContain("\\");
      expect(key).not.toContain("..");
      expect(key).not.toContain("\x00");
      expect(key).not.toContain("\n");
    }
  });
});

describe("resolveOAuthRefreshLockKey fuzz", () => {
  function makeSeededRandom(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomProfileId(rng: () => number, maxLen: number): string {
    const len = Math.floor(rng() * maxLen);
    const chars: string[] = [];
    for (let i = 0; i < len; i += 1) {
      const category = Math.floor(rng() * 5);
      const code =
        category === 0
          ? Math.floor(rng() * 128)
          : category === 1
            ? Math.floor(rng() * 32)
            : category === 2
              ? 0x10000 + Math.floor(rng() * 0xeffff)
              : category === 3
                ? Math.floor(rng() * 0xd800)
                : 0x0f00 + Math.floor(rng() * 0x0100);
      chars.push(String.fromCodePoint(code));
    }
    return chars.join("");
  }

  it("always produces sha256-<hex64> regardless of input", () => {
    const rng = makeSeededRandom(0x2026_0417);
    for (let i = 0; i < 500; i += 1) {
      const provider = randomProfileId(rng, 64) || "openai-codex";
      const id = randomProfileId(rng, 4096);
      const key = resolveOAuthRefreshLockKey(provider, id);
      expect(key).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(Buffer.byteLength(key, "utf8")).toBeLessThan(255);
      expect(key).not.toContain("\\");
      expect(key).not.toContain("/");
      expect(key).not.toContain("\u0000");
      expect(key).not.toContain("\n");
      expect(key).not.toContain("\r");
      expect(key).not.toContain("..");
    }
  });

  it("distinct (provider, profileId) inputs produce distinct outputs over a large random sample", () => {
    const rng = makeSeededRandom(0x1234_5678);
    const seen = new Map<string, string>();
    let collisions = 0;
    for (let i = 0; i < 2000; i += 1) {
      const provider = randomProfileId(rng, 32) || "p";
      const id = randomProfileId(rng, 256);
      const composite = `${provider}\u0000${id}`;
      const resolved = resolveOAuthRefreshLockKey(provider, id);
      const existing = seen.get(resolved);
      if (existing !== undefined && existing !== composite) {
        collisions += 1;
      }
      seen.set(resolved, composite);
    }
    expect(collisions).toBe(0);
  });

  it("holding provider fixed, distinct profileIds never collide", () => {
    const rng = makeSeededRandom(0xf00dbabe);
    const seen = new Map<string, string>();
    let collisions = 0;
    for (let i = 0; i < 1000; i += 1) {
      const id = randomProfileId(rng, 128) || `id-${i}`;
      const resolved = resolveOAuthRefreshLockKey("openai-codex", id);
      const existing = seen.get(resolved);
      if (existing !== undefined && existing !== id) {
        collisions += 1;
      }
      seen.set(resolved, id);
    }
    expect(collisions).toBe(0);
  });

  it("holding profileId fixed, distinct providers never collide", () => {
    const rng = makeSeededRandom(0xbad1d00d);
    const seen = new Map<string, string>();
    let collisions = 0;
    for (let i = 0; i < 500; i += 1) {
      const provider = randomProfileId(rng, 64) || `provider-${i}`;
      const resolved = resolveOAuthRefreshLockKey(provider, "shared-profile-id");
      const existing = seen.get(resolved);
      if (existing !== undefined && existing !== provider) {
        collisions += 1;
      }
      seen.set(resolved, provider);
    }
    expect(collisions).toBe(0);
  });
});
