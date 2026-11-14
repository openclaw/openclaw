import { describe, expect, it, vi } from "vitest";
import {
  useAttachmentTestTransport,
  type AttachmentTestTransport,
} from "./transport.test-support.js";
const installAttachmentTestTransport = useAttachmentTestTransport();
import { lookup } from "node:dns/promises";
import {
  encodeGraphShareId,
  htmlTagAttributeValues,
  isDownloadableAttachment,
  isLikelyImageAttachment,
  normalizeContentType,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";

type SafeFetchParams = AttachmentTestTransport & {
  url?: string;
  allowHosts?: string[];
  authorizationAllowHosts?: string[];
  requestInit?: RequestInit;
};

async function safeFetch(params: SafeFetchParams) {
  installAttachmentTestTransport(params);
  return await safeFetchWithPolicy({
    url: params.url ?? "https://teams.sharepoint.com/file.pdf",
    requestInit: params.requestInit,
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
  redirect: boolean,
) {
  const url = redirect
    ? "https://graph.microsoft.com/file.pdf"
    : "https://attacker.trafficmanager.net/v3/attachments/att-1";
  const target = authorizationAllowHosts.includes("*")
    ? "https://cdn.example.com/storage/file.pdf"
    : "https://cdn.sharepoint.com/storage/file.pdf";
  const fetchMock = mockFetchWithRedirect(target, redirect ? url : "");
  const res = await safeFetch({
    url,
    allowHosts: authorizationAllowHosts.includes("*")
      ? ["*"]
      : redirect
        ? ["graph.microsoft.com", "sharepoint.com"]
        : ["trafficmanager.net"],
    authorizationAllowHosts,
    fetchFn: fetchMock,
    resolveFn: async () => ({ address: "13.107.136.10" }),
    requestInit: { headers: { Authorization: "Bearer secret" } },
  });
  expect(res.status).toBe(200);
  await res.body?.cancel();
  expect(fetchMock.mock.calls[0]?.[0]).toBe(url);
  expect(
    fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization") ?? ""),
  ).toEqual(redirect ? ["Bearer secret", expectedAuth] : [expectedAuth]);
  for (const [, init] of fetchMock.mock.calls) {
    expect(init).toHaveProperty("dispatcher");
  }
}

function mockFetchWithRedirect(target: string, source = "https://teams.sharepoint.com/file.pdf") {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === source && init?.redirect === "manual") {
      return new Response(null, { status: 302, headers: { location: target } });
    }
    return new Response("ok", { status: 200 });
  });
}

describe("safeFetch", () => {
  it.each([
    ["https://evil.example.com/steal", "allowlist"],
    ["http://internal.sharepoint.com/file", "https"],
  ])("blocks unsafe redirect %s", async (target, error) => {
    await expectBlockedFetch({ fetchFn: mockFetchWithRedirect(target) }, error, 1);
  });

  it("blocks a redirect to an allowlisted host that resolves to a private IP (DNS rebinding)", async () => {
    let callCount = 0;
    const fetchMock = mockFetchWithRedirect("https://evil.trafficmanager.net/metadata");
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

  it.each(["private/internal", "DNS failure"])("blocks initial DNS: %s", async (error) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expectBlockedFetch(
      {
        fetchFn: fetchMock,
        resolveFn: async () => {
          if (error === "DNS failure") {
            throw new Error(error);
          }
          return { address: "10.0.0.1" };
        },
      },
      error,
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

    await expect(safeFetch({ fetchFn: fetchMock })).rejects.toThrow("Too many redirects");
  });

  it.each([
    [["graph.microsoft.com"], "", true],
    [["graph.microsoft.com", "sharepoint.com"], "Bearer secret", true],
    [["*"], "Bearer secret", true],
    [["smba.trafficmanager.net"], "", false],
  ] satisfies [string[], string, boolean][])(
    "auth allowlist %j yields %s (redirect=%s)",
    async (hosts, auth, redirect) => {
      await expectRedirectAuthorization(hosts, auth, redirect);
    },
  );
});

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
  const shareId = encodeGraphShareId(url);
  expect(shareId).toMatch(/^u![A-Za-z0-9_-]+$/);
  expect(Buffer.from(shareId.slice(2), "base64url").toString("utf8")).toBe(url);
  expect(tryBuildGraphSharesUrlForSharedLink(url)).toBe(
    `https://graph.microsoft.com/v1.0/shares/${encodeGraphShareId(url)}/driveItem/content`,
  );
});

it("normalizeContentType preserves case-sensitive parameter values", () => {
  expect(normalizeContentType('  Text/HTML ; charset="X-Custom"  ')).toBe(
    'text/html; charset="X-Custom"',
  );
});

it("normalizeContentType returns undefined for non-string, empty, or whitespace input", () => {
  expect(normalizeContentType(undefined)).toBeUndefined();
  expect(normalizeContentType(123)).toBeUndefined();
  expect(normalizeContentType("   ")).toBeUndefined();
  expect(normalizeContentType("")).toBeUndefined();
});

it.each([
  ["Image/PNG", "download", true],
  ["Application/PDF", "doc", false],
] as const)("classifies mixed-case %s without a filename hint", (contentType, name, expected) => {
  expect(isLikelyImageAttachment({ contentType, name })).toBe(expected);
});

it("recognizes the Teams download-info attachment type regardless of casing", () => {
  expect(
    isDownloadableAttachment({
      contentType: "Application/Vnd.Microsoft.Teams.File.Download.Info",
      content: { downloadUrl: "https://example.com/file" },
    }),
  ).toBe(true);
});

describe("htmlTagAttributeValues", () => {
  const values = (html: string, tag: "img" | "attachment", attr: "src" | "id") =>
    htmlTagAttributeValues(html, tag, attr);

  it("reads one value per tag, keeping the last spelling inside each tag", () => {
    expect(
      values('<img data-src="a.png" src="b.png"><p>x</p><IMG alt=x SRC=\'cid:c\'>', "img", "src"),
    ).toEqual(["b.png", "cid:c"]);
    expect(
      values(
        '<attachment id="one"></attachment><attachment fluid="no" id="two">',
        "attachment",
        "id",
      ),
    ).toEqual(["one", "two"]);
  });

  it("keeps a quoted value containing > and skips tags without a usable value", () => {
    expect(values('<img src="a>b" alt="x">', "img", "src")).toEqual(["a>b"]);
    expect(values('<img src="">, <img alt="x">, <img src="open', "img", "src")).toEqual([]);
  });
});
