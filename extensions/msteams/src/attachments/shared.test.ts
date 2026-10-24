import { describe, expect, it, vi } from "vitest";
import {
  useAttachmentTestTransport,
  type AttachmentTestTransport,
} from "./transport.test-support.js";
const installAttachmentTestTransport = useAttachmentTestTransport();
import { lookup } from "node:dns/promises";
import {
  encodeGraphShareId,
  isDownloadableAttachment,
  isLikelyImageAttachment,
  normalizeContentType,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";

const publicResolve = async () => ({ address: "13.107.136.10" });

type SafeFetchParams = Omit<
  Parameters<typeof safeFetchWithPolicy>[0],
  "policy" | "resolveFn" | "url"
> &
  AttachmentTestTransport & {
    url?: string;
    allowHosts?: string[];
    authorizationAllowHosts?: string[];
  };

async function safeFetch(params: SafeFetchParams) {
  installAttachmentTestTransport({
    fetchFn: params.fetchFn,
    resolveFn: params.resolveFn ?? publicResolve,
  });
  return await safeFetchWithPolicy({
    url: params.url ?? "https://teams.sharepoint.com/file.pdf",
    requestInit: params.requestInit,
    timeoutMs: params.timeoutMs,
    resolveFn: lookup,
    policy: {
      allowHosts: params.allowHosts ?? ["sharepoint.com"],
      authAllowHosts: params.authorizationAllowHosts ?? [],
    },
  });
}

async function expectBlockedFetch(params: SafeFetchParams, error: string, calls = 0) {
  await expect(safeFetch(params)).rejects.toThrow(error);
  expect(params.fetchFn).toHaveBeenCalledTimes(calls);
}

async function expectRedirectAuthorization(
  authorizationAllowHosts: string[],
  expectedAuth: string,
  target = "https://cdn.sharepoint.com/storage/file.pdf",
) {
  const url = "https://graph.microsoft.com/file.pdf";
  const fetchMock = mockFetchWithRedirect({ [url]: target });
  const res = await safeFetch({
    url,
    allowHosts: authorizationAllowHosts.includes("*")
      ? ["*"]
      : ["graph.microsoft.com", "sharepoint.com"],
    authorizationAllowHosts,
    fetchFn: fetchMock,
    resolveFn: publicResolve,
    requestInit: { headers: { Authorization: "Bearer secret" } },
  });
  expect(res.status).toBe(200);
  await res.body?.cancel();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization") ?? ""),
  ).toEqual(["Bearer secret", expectedAuth]);
  for (const [, init] of fetchMock.mock.calls) {
    expect(init).toHaveProperty("dispatcher");
  }
}

function mockFetchWithRedirect(redirectMap: Record<string, string>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = redirectMap[url];
    if (target && init?.redirect === "manual") {
      return new Response(null, {
        status: 302,
        headers: { location: target },
      });
    }
    return new Response("ok", { status: 200 });
  });
}

describe("safeFetch", () => {
  it("blocks a redirect to a non-allowlisted host", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://evil.example.com/steal",
    });
    await expectBlockedFetch({ fetchFn: fetchMock }, "allowlist", 1);
  });

  it("blocks a redirect to an allowlisted host that resolves to a private IP (DNS rebinding)", async () => {
    let callCount = 0;
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://evil.trafficmanager.net/metadata",
    });
    await expectBlockedFetch(
      {
        allowHosts: ["sharepoint.com", "trafficmanager.net"],
        fetchFn: fetchMock,
        resolveFn: async () => ({
          address: ++callCount === 1 ? "13.107.136.10" : "169.254.169.254",
        }),
      },
      "private/internal",
      1,
    );
  });

  it("blocks when the initial URL resolves to a private IP", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expectBlockedFetch(
      {
        fetchFn: fetchMock,
        resolveFn: async () => ({ address: "10.0.0.1" }),
      },
      "private/internal",
    );
  });

  it("blocks when initial URL DNS resolution fails", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expectBlockedFetch(
      {
        fetchFn: fetchMock,
        resolveFn: async () => {
          throw new Error("DNS failure");
        },
      },
      "DNS failure",
    );
  });

  it("throws on too many redirects", async () => {
    let counter = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.redirect === "manual") {
        return new Response(null, {
          status: 302,
          headers: { location: `https://loop${++counter}.sharepoint.com/x` },
        });
      }
      return new Response("ok", { status: 200 });
    });

    await expect(
      safeFetch({
        url: "https://start.sharepoint.com/x",
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow("Too many redirects");
  });

  it("blocks redirect to HTTP (non-HTTPS)", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "http://internal.sharepoint.com/file",
    });
    await expect(safeFetch({ fetchFn: fetchMock })).rejects.toThrow("https");
  });

  it("strips authorization across redirects outside auth allowlist", async () => {
    await expectRedirectAuthorization(["graph.microsoft.com"], "");
  });

  it("keeps authorization across redirects inside auth allowlist", async () => {
    await expectRedirectAuthorization(["graph.microsoft.com", "sharepoint.com"], "Bearer secret");
  });

  it("keeps authorization across HTTPS redirects when auth allowlist is wildcard", async () => {
    await expectRedirectAuthorization(
      ["*"],
      "Bearer secret",
      "https://cdn.example.com/storage/file.pdf",
    );
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
    expect(tryBuildGraphSharesUrlForSharedLink(url) !== undefined).toBe(expected);
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

it("normalizeContentType preserves case-sensitive parameter values", () => {
  expect(normalizeContentType('  Text/HTML ; charset="X-Custom"  ')).toBe(
    'text/html; charset="X-Custom"',
  );
});

it("normalizeContentType returns undefined for non-string, empty, or whitespace input", () => {
  expect(normalizeContentType(undefined)).toBeUndefined();
  expect(normalizeContentType(123 as unknown as string)).toBeUndefined();
  expect(normalizeContentType("   ")).toBeUndefined();
  expect(normalizeContentType("")).toBeUndefined();
});

it("recognizes an image with a mixed-case content type and no filename hint", () => {
  expect(isLikelyImageAttachment({ contentType: "Image/PNG", name: "download" })).toBe(true);
});

it("isLikelyImageAttachment still rejects non-image types (regression)", () => {
  expect(isLikelyImageAttachment({ contentType: "Application/PDF", name: "doc" })).toBe(false);
});

it("recognizes the Teams download-info attachment type regardless of casing", () => {
  expect(
    isDownloadableAttachment({
      contentType: "Application/Vnd.Microsoft.Teams.File.Download.Info",
      content: { downloadUrl: "https://example.com/file" },
    }),
  ).toBe(true);
});
