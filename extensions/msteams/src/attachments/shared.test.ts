import { describe, expect, it, vi } from "vitest";
import {
  encodeGraphShareId,
  isDownloadableAttachment,
  isLikelyImageAttachment,
  normalizeContentType,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";

const publicResolve = async () => ({ address: "13.107.136.10" });
const privateResolve = (ip: string) => async () => ({ address: ip });
const failingResolve = async () => {
  throw new Error("DNS failure");
};

const isGraphSharedLinkUrl = (url: string) =>
  tryBuildGraphSharesUrlForSharedLink(url) !== undefined;

type SafeFetchParams = Omit<Parameters<typeof safeFetchWithPolicy>[0], "policy"> & {
  allowHosts: string[];
  authorizationAllowHosts?: string[];
};

async function safeFetch(params: SafeFetchParams) {
  const { allowHosts, authorizationAllowHosts, ...request } = params;
  return await safeFetchWithPolicy({
    ...request,
    policy: {
      allowHosts,
      authAllowHosts: authorizationAllowHosts ?? [],
    },
    resolveFn: request.resolveFn ?? publicResolve,
  });
}

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

describe("safeFetch", () => {
  it("fails explicitly for custom fetch functions that cannot receive the pinned dispatcher", async () => {
    let called = false;
    const customFetch = async () => {
      called = true;
      return new Response("ok", { status: 200 });
    };

    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: customFetch as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("fetchFnSupportsDispatcher");
    expect(called).toBe(false);
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
    ).rejects.toThrow("allowlist");
    // Should not have fetched the evil URL
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to an allowlisted host that resolves to a private IP (DNS rebinding)", async () => {
    let callCount = 0;
    const rebindingResolve = async () => {
      callCount++;
      // First call (initial URL) resolves to public IP
      if (callCount === 1) {
        return { address: "13.107.136.10" };
      }
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
    ).rejects.toThrow("private/internal");
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
    ).rejects.toThrow("private/internal");
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
    ).rejects.toThrow("DNS failure");
    expect(fetchMock).not.toHaveBeenCalled();
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
    ).rejects.toThrow("https");
  });

  it("strips authorization across redirects outside auth allowlist", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuth.push(`${url}|${auth}`);
      if (url === "https://graph.microsoft.com/v1.0/me/photo") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.sharepoint.com/storage/file.pdf" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const headers = new Headers({ Authorization: "Bearer secret" });
    const res = await safeFetch({
      url: "https://graph.microsoft.com/v1.0/me/photo",
      allowHosts: ["graph.microsoft.com", "sharepoint.com"],
      authorizationAllowHosts: ["graph.microsoft.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers },
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(seenAuth[0]).toContain("Bearer secret");
    expect(seenAuth[1]).toMatch(/\|$/);
  });

  it("keeps authorization across redirects inside auth allowlist", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuth.push(`${url}|${auth}`);
      if (url === "https://graph.microsoft.com/file.pdf") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.sharepoint.com/storage/file.pdf" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const headers = new Headers({ Authorization: "Bearer secret" });
    const res = await safeFetch({
      url: "https://graph.microsoft.com/file.pdf",
      allowHosts: ["graph.microsoft.com", "sharepoint.com"],
      authorizationAllowHosts: ["graph.microsoft.com", "sharepoint.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers },
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(seenAuth[0]).toContain("Bearer secret");
    expect(seenAuth[1]).toContain("Bearer secret");
  });

  it("keeps authorization across HTTPS redirects when auth allowlist is wildcard", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuth.push(`${url}|${auth}`);
      if (url === "https://graph.microsoft.com/file.pdf") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/storage/file.pdf" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const headers = new Headers({ Authorization: "Bearer secret" });
    const res = await safeFetch({
      url: "https://graph.microsoft.com/file.pdf",
      allowHosts: ["*"],
      authorizationAllowHosts: ["*"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers },
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(seenAuth[0]).toContain("Bearer secret");
    expect(seenAuth[1]).toContain("Bearer secret");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toHaveProperty("dispatcher");
    }
  });

  it("strips authorization from the initial fetch outside auth allowlist", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      expect(url).toBe("https://attacker.trafficmanager.net/v3/attachments/att-1");
      return new Response("ok", { status: 200 });
    });

    const res = await safeFetch({
      url: "https://attacker.trafficmanager.net/v3/attachments/att-1",
      allowHosts: ["trafficmanager.net"],
      authorizationAllowHosts: ["smba.trafficmanager.net"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers: { Authorization: "Bearer secret" } },
      resolveFn: publicResolve,
    });

    expect(res.status).toBe(200);
    expect(seenAuth).toEqual([""]);
  });
});

describe("Graph shared-link helpers", () => {
  it.each([
    ["https://onedrive.live.com/view.aspx?resid=ABC", true],
    ["https://notonedrive.com/x", false],
    ["http://onedrive.com/x", false],
    ["not-a-url", false],
  ])("isGraphSharedLinkUrl(%s) === %s", (url, expected) => {
    expect(isGraphSharedLinkUrl(url)).toBe(expected);
  });

  it("tryBuildGraphSharesUrlForSharedLink rewrites SharePoint URLs", () => {
    const url = "https://contoso.sharepoint.com/personal/user/Documents/report.pdf";
    const result = tryBuildGraphSharesUrlForSharedLink(url);
    const shareId = encodeGraphShareId(url);
    expect(shareId).toMatch(/^u![A-Za-z0-9_-]+$/);
    expect(Buffer.from(shareId.slice(2), "base64url").toString("utf8")).toBe(url);
    expect(result).toBe(
      `https://graph.microsoft.com/v1.0/shares/${encodeGraphShareId(url)}/driveItem/content`,
    );
  });
});

describe("normalizeContentType case-insensitivity", () => {
  it("preserves case-sensitive parameter values", () => {
    expect(normalizeContentType('  Text/HTML ; charset="X-Custom"  ')).toBe(
      'text/html; charset="X-Custom"',
    );
  });

  it("returns undefined for non-string, empty, or whitespace input", () => {
    expect(normalizeContentType(undefined)).toBeUndefined();
    expect(normalizeContentType(123 as unknown as string)).toBeUndefined();
    expect(normalizeContentType("   ")).toBeUndefined();
    expect(normalizeContentType("")).toBeUndefined();
  });
});

describe("isLikelyImageAttachment mixed-case content type", () => {
  it("recognizes an image with a mixed-case content type and no filename hint", () => {
    expect(isLikelyImageAttachment({ contentType: "Image/PNG", name: "download" })).toBe(true);
    expect(isLikelyImageAttachment({ contentType: "image/png", name: "download" })).toBe(true);
  });

  it("still rejects non-image types (regression)", () => {
    expect(isLikelyImageAttachment({ contentType: "Application/PDF", name: "doc" })).toBe(false);
  });
});

describe("isDownloadableAttachment mixed-case download-info type", () => {
  it("recognizes the Teams download-info attachment type regardless of casing", () => {
    const content = { downloadUrl: "https://example.com/file" };
    expect(
      isDownloadableAttachment({
        contentType: "Application/Vnd.Microsoft.Teams.File.Download.Info",
        content,
      }),
    ).toBe(true);
    expect(
      isDownloadableAttachment({
        contentType: "application/vnd.microsoft.teams.file.download.info",
        content,
      }),
    ).toBe(true);
  });
});
