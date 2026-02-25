import { describe, expect, it, vi } from "vitest";
import { isPrivateOrReservedIP, resolveAndValidateIP, safeFetch } from "./shared.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const publicResolve = async () => ({ address: "13.107.136.10" });
const privateResolve = (ip: string) => async () => ({ address: ip });
const failingResolve = async () => {
  throw new Error("DNS failure");
};

function mockFetchWithRedirect(redirectMap: Record<string, string>, finalBody = "ok") {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const target = redirectMap[url];
    if (target && init?.redirect === "manual") {
      return new Response(null, {
        status: 302,
        headers: { location: target },
      });
    }
    return new Response(finalBody, { status: 200 });
  });
}

// ─── isPrivateOrReservedIP ───────────────────────────────────────────────────

describe("isPrivateOrReservedIP", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["169.254.0.1", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["13.107.136.10", false],
    ["52.96.0.1", false],
  ] as const)("IPv4 %s → %s", (ip, expected) => {
    expect(isPrivateOrReservedIP(ip)).toBe(expected);
  });

  it.each([
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["2001:0db8::1", false],
    ["2620:1ec:c11::200", false],
    // IPv4-mapped IPv6 addresses
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:192.168.1.1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:8.8.8.8", false],
    ["::ffff:13.107.136.10", false],
  ] as const)("IPv6 %s → %s", (ip, expected) => {
    expect(isPrivateOrReservedIP(ip)).toBe(expected);
  });

  it.each([
    ["999.999.999.999", true],
    ["256.0.0.1", true],
    ["10.0.0.256", true],
    ["-1.0.0.1", false],
    ["1.2.3.4.5", false],
    ["0:0:0:0:0:0:0:1", true],
  ] as const)("malformed/expanded %s → %s (SDK fails closed)", (ip, expected) => {
    expect(isPrivateOrReservedIP(ip)).toBe(expected);
  });
});

// ─── resolveAndValidateIP ────────────────────────────────────────────────────

describe("resolveAndValidateIP", () => {
  it("accepts a hostname resolving to a public IP", async () => {
    const ip = await resolveAndValidateIP("teams.sharepoint.com", publicResolve);
    expect(ip).toBe("13.107.136.10");
  });

  it("rejects a hostname resolving to 10.x.x.x", async () => {
    await expect(resolveAndValidateIP("evil.test", privateResolve("10.0.0.1"))).rejects.toThrow(
      "private/reserved IP",
    );
  });

  it("rejects a hostname resolving to 169.254.169.254", async () => {
    await expect(
      resolveAndValidateIP("evil.test", privateResolve("169.254.169.254")),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects a hostname resolving to loopback", async () => {
    await expect(resolveAndValidateIP("evil.test", privateResolve("127.0.0.1"))).rejects.toThrow(
      "private/reserved IP",
    );
  });

  it("rejects a hostname resolving to IPv6 loopback", async () => {
    await expect(resolveAndValidateIP("evil.test", privateResolve("::1"))).rejects.toThrow(
      "private/reserved IP",
    );
  });

  it("throws on DNS resolution failure", async () => {
    await expect(resolveAndValidateIP("nonexistent.test", failingResolve)).rejects.toThrow(
      "DNS resolution failed",
    );
  });
});

// ─── safeFetch ───────────────────────────────────────────────────────────────

describe("safeFetch", () => {
  it("fetches a URL directly when no redirect occurs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("ok", { status: 200 });
    });
    const res = await safeFetch({
      url: "https://teams.sharepoint.com/file.pdf",
      allowHosts: ["sharepoint.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    // Should have used redirect: "manual"
    expect(fetchMock.mock.calls[0][1]).toHaveProperty("redirect", "manual");
  });

  it("follows a redirect to an allowlisted host with public IP", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://cdn.sharepoint.com/storage/file.pdf",
    });
    const res = await safeFetch({
      url: "https://teams.sharepoint.com/file.pdf",
      allowHosts: ["sharepoint.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect to a non-allowlisted host", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://evil.example.com/steal",
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("blocked by allowlist");
    // Should not have fetched the evil URL
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to an allowlisted host that resolves to a private IP (DNS rebinding)", async () => {
    let callCount = 0;
    const rebindingResolve = async () => {
      callCount++;
      // First call (initial URL) resolves to public IP
      if (callCount === 1) return { address: "13.107.136.10" };
      // Second call (redirect target) resolves to private IP
      return { address: "169.254.169.254" };
    };

    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://evil.trafficmanager.net/metadata",
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com", "trafficmanager.net"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: rebindingResolve,
      }),
    ).rejects.toThrow("private/reserved IP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks when the initial URL resolves to a private IP", async () => {
    const fetchMock = vi.fn();
    await expect(
      safeFetch({
        url: "https://evil.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: privateResolve("10.0.0.1"),
      }),
    ).rejects.toThrow("Initial download URL blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks when initial URL DNS resolution fails", async () => {
    const fetchMock = vi.fn();
    await expect(
      safeFetch({
        url: "https://nonexistent.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: failingResolve,
      }),
    ).rejects.toThrow("Initial download URL blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows multiple redirects when all are valid", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://a.sharepoint.com/1" && init?.redirect === "manual") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.sharepoint.com/2" },
        });
      }
      if (url === "https://b.sharepoint.com/2" && init?.redirect === "manual") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://c.sharepoint.com/3" },
        });
      }
      return new Response("final", { status: 200 });
    });

    const res = await safeFetch({
      url: "https://a.sharepoint.com/1",
      allowHosts: ["sharepoint.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws on too many redirects", async () => {
    let counter = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.redirect === "manual") {
        counter++;
        return new Response(null, {
          status: 302,
          headers: { location: `https://loop${counter}.sharepoint.com/x` },
        });
      }
      return new Response("ok", { status: 200 });
    });

    await expect(
      safeFetch({
        url: "https://start.sharepoint.com/x",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("Too many redirects");
  });

  it("blocks redirect to HTTP (non-HTTPS)", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file": "http://internal.sharepoint.com/file",
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("blocked by allowlist");
  });
});
