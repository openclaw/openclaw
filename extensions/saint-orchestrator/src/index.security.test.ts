import { describe, expect, it } from "vitest";
import { __testing } from "../index.js";

describe("isBlockedUrl hardening", () => {
  it("blocks standard loopback addresses", () => {
    expect(__testing.isBlockedUrl("http://127.0.0.1/admin")).toBe(true);
    expect(__testing.isBlockedUrl("http://127.0.0.2/admin")).toBe(true);
    expect(__testing.isBlockedUrl("http://127.1.2.3/admin")).toBe(true);
    expect(__testing.isBlockedUrl("http://localhost/admin")).toBe(true);
  });

  it("blocks IPv6 loopback [::1]", () => {
    expect(__testing.isBlockedUrl("http://[::1]/admin")).toBe(true);
  });

  it("blocks 0.0.0.0", () => {
    expect(__testing.isBlockedUrl("http://0.0.0.0/admin")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 addresses (dotted decimal)", () => {
    expect(__testing.isBlockedUrl("http://[::ffff:127.0.0.1]/admin")).toBe(true);
    expect(__testing.isBlockedUrl("http://[::ffff:10.0.0.1]/admin")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 addresses (hex-normalized by Node URL parser)", () => {
    // Node.js normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1
    expect(__testing.isBlockedUrl("http://[::ffff:7f00:1]/admin")).toBe(true);
    // Node.js normalizes ::ffff:10.0.0.1 → ::ffff:a00:1
    expect(__testing.isBlockedUrl("http://[::ffff:a00:1]/admin")).toBe(true);
    // 192.168.1.1 → ::ffff:c0a8:101
    expect(__testing.isBlockedUrl("http://[::ffff:c0a8:101]/admin")).toBe(true);
  });

  it("blocks expanded IPv6 loopback", () => {
    expect(__testing.isBlockedUrl("http://[0:0:0:0:0:0:0:1]/admin")).toBe(true);
  });

  it("returns true for invalid/unparseable URLs", () => {
    expect(__testing.isBlockedUrl("not a url at all")).toBe(true);
  });

  it("blocks cloud metadata endpoint (169.254.x.x link-local)", () => {
    expect(__testing.isBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("blocks hex-encoded IP (0x7f000001 = 127.0.0.1)", () => {
    // Node's URL parser may or may not resolve hex IPs; either way the guard
    // should not let them through as legitimate external hosts.
    expect(__testing.isBlockedUrl("http://0x7f000001/")).toBe(true);
  });

  it("allows legitimate domain that resembles a private IP", () => {
    // 127.0.0.1.evil.com is a real external domain, not a loopback address.
    expect(__testing.isBlockedUrl("https://127.0.0.1.evil.com/")).toBe(false);
  });

  it("blocks IPv6 link-local addresses (fe80::/10)", () => {
    expect(__testing.isBlockedUrl("http://[fe80::1]/admin")).toBe(true);
    expect(__testing.isBlockedUrl("http://[fea0::1]/admin")).toBe(true);
  });

  it("blocks 172.16.0.0/12 private range", () => {
    expect(__testing.isBlockedUrl("http://172.16.0.1/")).toBe(true);
  });

  it("allows legitimate external URLs", () => {
    expect(__testing.isBlockedUrl("https://docs.openclaw.ai/help")).toBe(false);
    expect(__testing.isBlockedUrl("https://api.example.com/data")).toBe(false);
  });
});

describe("exec blocklist hardening", () => {
  it("blocks /agent config/private reads for manager and employee tiers", () => {
    const manager = __testing.FALLBACK_CUSTOM.manager;
    const employee = __testing.FALLBACK_CUSTOM.employee;
    expect(__testing.isExecBlocked(manager, "cat /agent/config/tiers.yaml")).toBe(true);
    expect(__testing.isExecBlocked(manager, "cat /agent/memory/private/roadmap.md")).toBe(true);
    expect(__testing.isExecBlocked(employee, "cat /agent/config/contacts.json")).toBe(true);
    expect(__testing.isExecBlocked(employee, "cat /agent/memory/private/plan.md")).toBe(true);
  });
});

describe("matchPattern (linear-time glob)", () => {
  it("matches wildcard-only pattern", () => {
    expect(__testing.matchPattern("anything", "*")).toBe(true);
    expect(__testing.matchPattern("", "*")).toBe(true);
  });

  it("matches exact strings (no wildcard)", () => {
    expect(__testing.matchPattern("hello", "hello")).toBe(true);
    expect(__testing.matchPattern("hello", "hell")).toBe(false);
    expect(__testing.matchPattern("hell", "hello")).toBe(false);
  });

  it("matches prefix wildcards (e.g. *.txt)", () => {
    expect(__testing.matchPattern("report.txt", "*.txt")).toBe(true);
    expect(__testing.matchPattern("report.pdf", "*.txt")).toBe(false);
  });

  it("matches suffix wildcards (e.g. report.*)", () => {
    expect(__testing.matchPattern("report.txt", "report.*")).toBe(true);
    expect(__testing.matchPattern("summary.txt", "report.*")).toBe(false);
  });

  it("matches middle wildcards (e.g. re*rt)", () => {
    expect(__testing.matchPattern("report", "re*rt")).toBe(true);
    expect(__testing.matchPattern("resort", "re*rt")).toBe(true);
    expect(__testing.matchPattern("reset", "re*rt")).toBe(false);
  });

  it("matches multiple wildcards", () => {
    expect(__testing.matchPattern("a/b/c.txt", "a/*/c.*")).toBe(true);
    expect(__testing.matchPattern("a/x/c.md", "a/*/c.*")).toBe(true);
    expect(__testing.matchPattern("a/b/d.txt", "a/*/c.*")).toBe(false);
  });

  it("treats * as single-segment for slash-delimited paths", () => {
    expect(__testing.matchPattern("memory/users/alice/preferences.md", "memory/users/*/*")).toBe(
      true,
    );
    expect(
      __testing.matchPattern("memory/users/team/alice/preferences.md", "memory/users/*/*"),
    ).toBe(false);
  });

  it("supports ** as recursive glob for slash-delimited paths", () => {
    expect(
      __testing.matchPattern("memory/users/team/alice/preferences.md", "memory/users/**/*"),
    ).toBe(true);
    expect(__testing.matchPattern("a/b/c/d.txt", "a/**/d.*")).toBe(true);
  });

  it("handles empty segments from consecutive wildcards", () => {
    expect(__testing.matchPattern("abc", "**")).toBe(true);
    expect(__testing.matchPattern("abc", "a**c")).toBe(true);
  });

  it("does not allow prefix-only match for exact patterns", () => {
    expect(__testing.matchPattern("hello world", "hello")).toBe(false);
    expect(__testing.matchPattern("web_search_advanced", "web_search")).toBe(false);
  });
});

describe("filterByCeiling", () => {
  it("returns tier list unchanged when ceiling is empty", () => {
    expect(__testing.filterByCeiling(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("intersects tier list with ceiling", () => {
    expect(__testing.filterByCeiling(["a", "b", "c"], ["b", "c", "d"])).toEqual(["b", "c"]);
  });

  it("returns empty when no overlap", () => {
    expect(__testing.filterByCeiling(["a", "b"], ["c", "d"])).toEqual([]);
  });

  it("handles empty tier list", () => {
    expect(__testing.filterByCeiling([], ["a", "b"])).toEqual([]);
  });
});

describe("clampByCeiling with file_access", () => {
  it("clamps file_access.read and file_access.write against ceiling", () => {
    const tier = {
      tools: ["web_search"],
      memory_scope: ["own_user"],
      skills: [],
      max_budget_usd: 1,
      file_access: {
        read: ["data", "config", "secrets"],
        write: ["data", "logs"],
      },
    };
    const ceiling = {
      tools: ["web_search", "web_fetch"],
      memory_scope: ["own_user"],
      skills: [],
      max_budget_usd: 2,
      file_access: {
        read: ["data", "config"],
        write: ["data"],
      },
    };

    const clamped = __testing.clampByCeiling(tier, ceiling);
    expect(clamped.file_access?.read).toEqual(["data", "config"]);
    expect(clamped.file_access?.write).toEqual(["data"]);
  });
});
