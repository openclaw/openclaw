import { describe, expect, it } from "vitest";
import {
  isBlockedIp,
  resolveAdp,
  validateAdpPayload,
  validateDomain,
} from "./adp-resolver.js";

const SAMPLE_PAYLOAD = {
  agent_discovery_version: "0.1",
  domain: "example.com",
  services: [
    {
      name: "memory",
      description: "Persistent memory",
      endpoint: "https://example.com/api/memory",
      auth: "bearer",
      governance: "none",
      free_tier: true,
    },
    {
      name: "identity",
      endpoint: "https://example.com/api/register",
    },
  ],
  trust: { verification_url: "https://example.com/verify" },
};

const PUBLIC_IP = "93.184.216.34";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

function fetchThrowing(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe("validateDomain", () => {
  it("accepts a normal FQDN", () => {
    expect(validateDomain("example.com")).toBeNull();
    expect(validateDomain("a.b.example.co.uk")).toBeNull();
  });

  it("rejects empty", () => {
    expect(validateDomain("")).toMatch(/non-empty/);
  });

  it("rejects IP literals", () => {
    expect(validateDomain("127.0.0.1")).toMatch(/invalid/);
  });

  it("rejects URLs", () => {
    expect(validateDomain("https://example.com")).toMatch(/invalid/);
  });

  it("rejects userinfo injection", () => {
    expect(validateDomain("admin:pass@evil.com")).toMatch(/invalid/);
  });

  it("rejects single-label hosts (no TLD)", () => {
    expect(validateDomain("localhost")).toMatch(/invalid/);
  });
});

describe("isBlockedIp", () => {
  it("blocks loopback v4", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.255.255.255")).toBe(true);
  });

  it("blocks RFC1918 ranges", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("10.255.255.255")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("172.32.0.1")).toBe(false); // outside 172.16/12
    expect(isBlockedIp("192.168.1.1")).toBe(true);
  });

  it("blocks cloud metadata IP", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("blocks CGNAT", () => {
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("100.127.255.255")).toBe(true);
    expect(isBlockedIp("100.128.0.1")).toBe(false); // outside 100.64/10
  });

  it("blocks IPv6 loopback and ULA and link-local", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
  });

  it("blocks IPv4-mapped private addresses", () => {
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows public addresses", () => {
    expect(isBlockedIp(PUBLIC_IP)).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks garbage", () => {
    expect(isBlockedIp("not.an.ip")).toBe(true);
    expect(isBlockedIp("999.999.999.999")).toBe(true);
  });
});

describe("validateAdpPayload", () => {
  it("accepts a well-formed payload", () => {
    const v = validateAdpPayload(SAMPLE_PAYLOAD, "example.com");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.result.format).toBe("adp");
      expect(v.result.services.map((s) => s.name)).toEqual(["memory", "identity"]);
      expect(v.result.trust).toBeDefined();
    }
  });

  it("rejects non-object payloads", () => {
    expect(validateAdpPayload(["not", "a", "dict"], "example.com")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/JSON object/),
    });
    expect(validateAdpPayload("nope", "example.com")).toMatchObject({ ok: false });
    expect(validateAdpPayload(null, "example.com")).toMatchObject({ ok: false });
  });

  it("rejects services not being a list", () => {
    expect(
      validateAdpPayload({ services: { memory: {} } }, "example.com"),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/services/) });
  });

  it("rejects service entries that are not objects", () => {
    expect(
      validateAdpPayload({ services: ["just-a-string"] }, "example.com"),
    ).toMatchObject({ ok: false });
  });

  it("rejects service entries missing a name", () => {
    expect(
      validateAdpPayload({ services: [{ endpoint: "https://x" }] }, "example.com"),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/name/) });
  });

  it("rejects empty service name", () => {
    expect(
      validateAdpPayload({ services: [{ name: "" }] }, "example.com"),
    ).toMatchObject({ ok: false });
  });

  it("rejects non-string service name", () => {
    expect(
      validateAdpPayload({ services: [{ name: 42 }] }, "example.com"),
    ).toMatchObject({ ok: false });
  });

  it("accepts empty services list", () => {
    const v = validateAdpPayload({ services: [] }, "example.com");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.result.services).toEqual([]);
  });

  it("falls back to provided domain when payload omits it", () => {
    const v = validateAdpPayload({ services: [] }, "fallback.example.com");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.result.domain).toBe("fallback.example.com");
  });
});

describe("resolveAdp", () => {
  it("returns ok on a valid 200 response", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(jsonResponse(SAMPLE_PAYLOAD)),
      },
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.result.services.map((s) => s.name)).toEqual(["memory", "identity"]);
    }
  });

  it("returns not-found on 404", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(new Response("", { status: 404 })),
      },
    });
    expect(out.kind).toBe("not-found");
  });

  it("returns not-found on 410", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(new Response("", { status: 410 })),
      },
    });
    expect(out.kind).toBe("not-found");
  });

  it("returns transient on 5xx", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(new Response("", { status: 503 })),
      },
    });
    expect(out.kind).toBe("transient");
  });

  it("returns transient on 3xx (no redirects allowed)", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(
          new Response("", { status: 302, headers: { location: "https://evil.example.com/" } }),
        ),
      },
    });
    expect(out.kind).toBe("transient");
  });

  it("rejects when DNS returns a private IP", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => ["10.0.0.1"],
        fetchImpl: fetchReturning(jsonResponse(SAMPLE_PAYLOAD)),
      },
    });
    expect(out.kind).toBe("transient");
    if (out.kind === "transient") expect(out.reason).toMatch(/blocked/);
  });

  it("rejects when ANY resolved IP is private (mixed multi-A)", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP, "10.0.0.1"],
        fetchImpl: fetchReturning(jsonResponse(SAMPLE_PAYLOAD)),
      },
    });
    expect(out.kind).toBe("transient");
  });

  it("rejects malformed domain", async () => {
    const out = await resolveAdp({
      domain: "127.0.0.1",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(jsonResponse(SAMPLE_PAYLOAD)),
      },
    });
    expect(out.kind).toBe("transient");
  });

  it("rejects when DNS throws", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => {
          throw new Error("ENOTFOUND");
        },
        fetchImpl: fetchReturning(jsonResponse(SAMPLE_PAYLOAD)),
      },
    });
    expect(out.kind).toBe("transient");
    if (out.kind === "transient") expect(out.reason).toMatch(/dns/);
  });

  it("rejects when fetch throws", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchThrowing(new Error("ECONNRESET")),
      },
    });
    expect(out.kind).toBe("transient");
  });

  it("rejects when content-length declares oversized body", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      config: { maxBodyBytes: 100 },
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(
          jsonResponse(SAMPLE_PAYLOAD, 200, { "content-length": "999999" }),
        ),
      },
    });
    expect(out.kind).toBe("transient");
    if (out.kind === "transient") expect(out.reason).toMatch(/too large/);
  });

  it("rejects when actual body exceeds cap (no content-length)", async () => {
    const huge = "x".repeat(2000);
    const out = await resolveAdp({
      domain: "example.com",
      config: { maxBodyBytes: 1000 },
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(new Response(huge, { status: 200 })),
      },
    });
    expect(out.kind).toBe("transient");
  });

  it("rejects malformed JSON", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(new Response("not json", { status: 200 })),
      },
    });
    expect(out.kind).toBe("transient");
    if (out.kind === "transient") expect(out.reason).toMatch(/json/);
  });

  it("rejects schema-invalid payload (wrong services type)", async () => {
    const out = await resolveAdp({
      domain: "example.com",
      deps: {
        resolveDns: async () => [PUBLIC_IP],
        fetchImpl: fetchReturning(jsonResponse({ services: "not-a-list" })),
      },
    });
    expect(out.kind).toBe("transient");
    if (out.kind === "transient") expect(out.reason).toMatch(/services/);
  });
});
