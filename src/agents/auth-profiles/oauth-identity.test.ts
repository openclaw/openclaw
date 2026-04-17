import { describe, expect, it } from "vitest";
import {
  isOAuthIdentityCompatible,
  isSameOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
} from "./oauth.js";

// Direct unit + fuzz tests for the cross-agent credential-mirroring identity
// gate introduced for #26322 (CWE-284). These helpers are on the hot-path of
// `mirrorRefreshedCredentialIntoMainStore` and must be strictly correct: a
// false positive means a sub-agent could poison the main-agent auth store.

describe("normalizeAuthIdentityToken", () => {
  it("returns trimmed value when non-empty", () => {
    expect(normalizeAuthIdentityToken("acct-123")).toBe("acct-123");
    expect(normalizeAuthIdentityToken("  acct-123  ")).toBe("acct-123");
  });

  it("returns undefined for undefined, empty, or whitespace-only input", () => {
    expect(normalizeAuthIdentityToken(undefined)).toBeUndefined();
    expect(normalizeAuthIdentityToken("")).toBeUndefined();
    expect(normalizeAuthIdentityToken("   ")).toBeUndefined();
    expect(normalizeAuthIdentityToken("\t\n\r")).toBeUndefined();
  });

  it("preserves case (accountIds are case-sensitive)", () => {
    expect(normalizeAuthIdentityToken("Acct-ABC")).toBe("Acct-ABC");
    expect(normalizeAuthIdentityToken("acct-abc")).toBe("acct-abc");
  });
});

describe("normalizeAuthEmailToken", () => {
  it("lowercases and trims email", () => {
    expect(normalizeAuthEmailToken("USER@Example.COM")).toBe("user@example.com");
    expect(normalizeAuthEmailToken("  user@example.com  ")).toBe("user@example.com");
  });

  it("returns undefined for undefined/empty/whitespace", () => {
    expect(normalizeAuthEmailToken(undefined)).toBeUndefined();
    expect(normalizeAuthEmailToken("")).toBeUndefined();
    expect(normalizeAuthEmailToken("   ")).toBeUndefined();
  });

  it("preserves internal plus-addressing and unicode", () => {
    expect(normalizeAuthEmailToken("User+Tag@Example.com")).toBe("user+tag@example.com");
    expect(normalizeAuthEmailToken("  JOSÉ@Example.com ")).toBe("josé@example.com");
  });
});

describe("isSameOAuthIdentity", () => {
  describe("accountId takes priority when present on both sides", () => {
    it("returns true when accountIds match", () => {
      expect(isSameOAuthIdentity({ accountId: "acct-1" }, { accountId: "acct-1" })).toBe(true);
    });

    it("returns true for accountId match even if emails differ", () => {
      expect(
        isSameOAuthIdentity(
          { accountId: "acct-1", email: "a@example.com" },
          { accountId: "acct-1", email: "b@example.com" },
        ),
      ).toBe(true);
    });

    it("returns false when accountIds mismatch, ignoring email", () => {
      expect(
        isSameOAuthIdentity(
          { accountId: "acct-1", email: "same@example.com" },
          { accountId: "acct-2", email: "same@example.com" },
        ),
      ).toBe(false);
    });

    it("treats whitespace-equal accountIds as same", () => {
      expect(isSameOAuthIdentity({ accountId: "  acct-1  " }, { accountId: "acct-1" })).toBe(true);
    });

    it("accountId is case-sensitive", () => {
      expect(isSameOAuthIdentity({ accountId: "Acct-1" }, { accountId: "acct-1" })).toBe(false);
    });
  });

  describe("email fallback when accountId missing on either side", () => {
    it("returns true when emails match (case-insensitive)", () => {
      expect(
        isSameOAuthIdentity({ email: "user@example.com" }, { email: "USER@Example.COM" }),
      ).toBe(true);
    });

    it("returns false when emails mismatch", () => {
      expect(isSameOAuthIdentity({ email: "a@example.com" }, { email: "b@example.com" })).toBe(
        false,
      );
    });

    it("matches when main has accountId+email and incoming has only matching email", () => {
      // Not asymmetric: both sides carry identity (main has more, but
      // incoming still has email). Email is a shared field with a
      // matching value — positive-identity match, safe to mirror.
      expect(
        isSameOAuthIdentity(
          { accountId: "acct-1", email: "user@example.com" },
          { email: "user@example.com" },
        ),
      ).toBe(true);
    });

    it("matches when accountIds on one side are whitespace-only and both sides expose matching email", () => {
      // Whitespace-only accountId is treated as absent; email falls back
      // symmetrically on both sides so the positive email match wins.
      expect(
        isSameOAuthIdentity(
          { accountId: "   ", email: "user@example.com" },
          { accountId: "", email: "USER@example.com" },
        ),
      ).toBe(true);
    });
  });

  describe("asymmetric identity evidence is refused", () => {
    it("refuses when main has accountId and incoming has neither", () => {
      expect(isSameOAuthIdentity({ accountId: "acct-1" }, {})).toBe(false);
    });

    it("refuses when main has email and incoming has neither", () => {
      expect(isSameOAuthIdentity({ email: "user@example.com" }, {})).toBe(false);
    });

    it("refuses when incoming has identity but main does not", () => {
      expect(isSameOAuthIdentity({}, { accountId: "acct-1" })).toBe(false);
      expect(isSameOAuthIdentity({}, { email: "user@example.com" })).toBe(false);
    });

    it("refuses when main has only accountId and incoming has only email (non-overlapping fields)", () => {
      expect(isSameOAuthIdentity({ accountId: "acct-1" }, { email: "user@example.com" })).toBe(
        false,
      );
    });
  });

  describe("no identity metadata on either side", () => {
    it("returns true (no evidence of mismatch) when both sides lack accountId and email", () => {
      // This matches the looser behaviour of the pre-existing
      // adoptNewerMainOAuthCredential gate; provider equality is the
      // caller's responsibility.
      expect(isSameOAuthIdentity({}, {})).toBe(true);
    });

    it("returns true when one side has empty strings for both fields", () => {
      expect(
        isSameOAuthIdentity(
          { accountId: "", email: "" },
          { accountId: undefined, email: undefined },
        ),
      ).toBe(true);
    });
  });

  describe("reflexivity and symmetry", () => {
    it("is reflexive: share(a,a) === true for any non-conflicting identity", () => {
      const a = { accountId: "acct-1", email: "a@example.com" };
      expect(isSameOAuthIdentity(a, a)).toBe(true);
    });

    it("is symmetric: share(a,b) === share(b,a)", () => {
      const a = { accountId: "acct-1" };
      const b = { accountId: "acct-2" };
      expect(isSameOAuthIdentity(a, b)).toBe(isSameOAuthIdentity(b, a));
    });
  });
});

// ---------------------------------------------------------------------------
// Fuzz tests. Seeded Mulberry32 so the run is reproducible.
// ---------------------------------------------------------------------------

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

function randomString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  const chars: string[] = [];
  for (let i = 0; i < len; i += 1) {
    chars.push(String.fromCodePoint(32 + Math.floor(rng() * 95))); // printable ASCII
  }
  return chars.join("");
}

function maybe<T>(rng: () => number, value: T): T | undefined {
  return rng() < 0.5 ? value : undefined;
}

describe("isOAuthIdentityCompatible (relaxed rule, used for adoption)", () => {
  describe("positive matches", () => {
    it("accepts matching accountIds", () => {
      expect(isOAuthIdentityCompatible({ accountId: "x" }, { accountId: "x" })).toBe(true);
    });

    it("accepts matching emails (case-insensitive)", () => {
      expect(
        isOAuthIdentityCompatible({ email: "u@example.com" }, { email: "U@Example.com" }),
      ).toBe(true);
    });

    it("accepts when both sides expose identical identity across accountId + email", () => {
      expect(
        isOAuthIdentityCompatible(
          { accountId: "x", email: "u@example.com" },
          { accountId: "x", email: "u@example.com" },
        ),
      ).toBe(true);
    });

    it("accepts when one side has accountId and the other has only email (no shared positive-mismatch field)", () => {
      // Relaxed rule: with no COMPARABLE shared field there is no positive
      // evidence of mismatch, so adoption is allowed. This is the case the
      // strict rule refuses.
      expect(isOAuthIdentityCompatible({ accountId: "x" }, { email: "u@example.com" })).toBe(true);
    });
  });

  describe("upgrade tolerance (primary motivator)", () => {
    it("accepts sub-with-no-identity adopting main-with-accountId", () => {
      // The #26322 upgrade case: sub cred predates accountId capture,
      // main has it. Must allow or the fix regresses on existing installs.
      expect(isOAuthIdentityCompatible({}, { accountId: "x" })).toBe(true);
    });

    it("accepts sub-with-no-identity adopting main-with-email", () => {
      expect(isOAuthIdentityCompatible({}, { email: "u@example.com" })).toBe(true);
    });

    it("accepts main-with-no-identity (unlikely but symmetric)", () => {
      expect(isOAuthIdentityCompatible({ accountId: "x" }, {})).toBe(true);
    });

    it("accepts when both sides lack identity metadata", () => {
      expect(isOAuthIdentityCompatible({}, {})).toBe(true);
    });
  });

  describe("positive mismatch still refuses (CWE-284 protection)", () => {
    it("refuses mismatching accountIds even when emails match", () => {
      expect(
        isOAuthIdentityCompatible(
          { accountId: "a", email: "u@example.com" },
          { accountId: "b", email: "u@example.com" },
        ),
      ).toBe(false);
    });

    it("refuses mismatching emails when both sides expose only email", () => {
      expect(
        isOAuthIdentityCompatible({ email: "a@example.com" }, { email: "b@example.com" }),
      ).toBe(false);
    });

    it("accountId is case-sensitive", () => {
      expect(isOAuthIdentityCompatible({ accountId: "X" }, { accountId: "x" })).toBe(false);
    });
  });

  describe("normalization", () => {
    it("ignores surrounding whitespace on accountId", () => {
      expect(isOAuthIdentityCompatible({ accountId: "  acct-1  " }, { accountId: "acct-1" })).toBe(
        true,
      );
    });

    it("ignores email case and whitespace", () => {
      expect(
        isOAuthIdentityCompatible({ email: "  U@Example.com  " }, { email: "u@example.com" }),
      ).toBe(true);
    });

    it("treats empty/whitespace-only identity as absent (allowed to adopt)", () => {
      expect(
        isOAuthIdentityCompatible({ accountId: "   ", email: "" }, { accountId: "acct-main" }),
      ).toBe(true);
    });
  });

  describe("reflexivity and symmetry", () => {
    it("is reflexive", () => {
      const a = { accountId: "acct-1", email: "u@example.com" };
      expect(isOAuthIdentityCompatible(a, a)).toBe(true);
    });

    it("is symmetric", () => {
      const a = { accountId: "acct-1" };
      const b = { accountId: "acct-2" };
      expect(isOAuthIdentityCompatible(a, b)).toBe(isOAuthIdentityCompatible(b, a));
    });
  });
});

describe("isOAuthIdentityCompatible fuzz", () => {
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

  function randomString(rng: () => number, maxLen: number): string {
    const len = Math.floor(rng() * maxLen);
    const chars: string[] = [];
    for (let i = 0; i < len; i += 1) {
      chars.push(String.fromCodePoint(32 + Math.floor(rng() * 95)));
    }
    return chars.join("");
  }

  function maybe<T>(rng: () => number, value: T): T | undefined {
    return rng() < 0.5 ? value : undefined;
  }

  it("is always symmetric", () => {
    const rng = makeSeededRandom(0x17_00_00_17);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      const b = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      expect(isOAuthIdentityCompatible(a, b)).toBe(isOAuthIdentityCompatible(b, a));
    }
  });

  it("is always reflexive", () => {
    const rng = makeSeededRandom(0xdeadbeef);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      expect(isOAuthIdentityCompatible(a, a)).toBe(true);
    }
  });

  it("always refuses distinct non-empty accountIds regardless of email", () => {
    const rng = makeSeededRandom(0xfaceb00c);
    for (let i = 0; i < 500; i += 1) {
      const idA = `A-${randomString(rng, 32) || "x"}`;
      const idB = `B-${randomString(rng, 32) || "y"}`;
      const email = `${randomString(rng, 16) || "u"}@example.com`;
      expect(isOAuthIdentityCompatible({ accountId: idA, email }, { accountId: idB, email })).toBe(
        false,
      );
    }
  });

  it("is at least as permissive as isSameOAuthIdentity (relaxed is weaker)", () => {
    // Property: if the strict rule accepts, the relaxed rule must also
    // accept. Never the other way around. Fuzz over random input pairs.
    const rng = makeSeededRandom(0x7777_7777);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 32)),
        email: maybe(rng, randomString(rng, 32)),
      };
      const b = {
        accountId: maybe(rng, randomString(rng, 32)),
        email: maybe(rng, randomString(rng, 32)),
      };
      if (isSameOAuthIdentity(a, b)) {
        expect(isOAuthIdentityCompatible(a, b)).toBe(true);
      }
    }
  });
});

describe("isSameOAuthIdentity fuzz", () => {
  it("is always symmetric regardless of input shape", () => {
    const rng = makeSeededRandom(0x0426_0417);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      const b = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      expect(isSameOAuthIdentity(a, b)).toBe(isSameOAuthIdentity(b, a));
    }
  });

  it("is always reflexive: share(a, a) is true", () => {
    const rng = makeSeededRandom(0x1234_abcd);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      expect(isSameOAuthIdentity(a, a)).toBe(true);
    }
  });

  it("never returns true for distinct non-empty accountIds (regardless of email)", () => {
    const rng = makeSeededRandom(0xfeedc0de);
    for (let i = 0; i < 500; i += 1) {
      const idA = `A-${randomString(rng, 32) || "x"}`;
      const idB = `B-${randomString(rng, 32) || "y"}`;
      // Shared email; mismatched accountId must still refuse.
      const email = `${randomString(rng, 16) || "u"}@example.com`;
      expect(isSameOAuthIdentity({ accountId: idA, email }, { accountId: idB, email })).toBe(false);
    }
  });

  it("email comparison is case-insensitive for random email bodies", () => {
    const rng = makeSeededRandom(0xcafef00d);
    for (let i = 0; i < 500; i += 1) {
      const local = randomString(rng, 16).replace(/[^A-Za-z0-9+._-]/g, "") || "user";
      const domain = (randomString(rng, 12).replace(/[^A-Za-z0-9.-]/g, "") || "example") + ".com";
      const email = `${local}@${domain}`;
      const randomizedCase = email
        .split("")
        .map((c) => (rng() < 0.5 ? c.toUpperCase() : c.toLowerCase()))
        .join("");
      expect(isSameOAuthIdentity({ email }, { email: randomizedCase })).toBe(true);
    }
  });
});
