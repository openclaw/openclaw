import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const MAX_RECIPE_BYTES = 25 * 1024 * 1024;
const SHARE_ID = /^[A-Za-z0-9_-]{3,128}$/u;
export type GrokBotUrl = { kind: "share"; shareId: string } | { kind: "marketplace"; url: string };

export function parseGrokBotUrl(value: string): GrokBotUrl {
  const url = new URL(value);
  if (url.username || url.password || url.port || url.hash) {
    throw new Error("Expected a Grok Bot share or marketplace URL without credentials.");
  }
  if (
    url.protocol === "grokbot:" &&
    url.hostname === "app" &&
    url.pathname === "/v1/bot-template"
  ) {
    const shareId = url.searchParams.get("id") ?? "";
    if (SHARE_ID.test(shareId) && [...url.searchParams.keys()].every((key) => key === "id")) {
      return { kind: "share", shareId };
    }
  }
  if (url.protocol === "https:" && url.hostname === "x.ai" && !url.search) {
    const marketplace = /^\/bot\/marketplace\/bots\/[a-z0-9-]+\/?$/u.test(url.pathname);
    if (marketplace) {
      return { kind: "marketplace", url: url.href };
    }
    const shareId = /^\/bot\/([A-Za-z0-9_-]+)\/?$/u.exec(url.pathname)?.[1];
    if (shareId && shareId !== "marketplace" && SHARE_ID.test(shareId)) {
      return { kind: "share", shareId };
    }
  }
  throw new Error("Expected a Grok Bot share or marketplace URL on https://x.ai/bot/.");
}

function shareIdFromMarketplaceHtml(html: string): string {
  // The page's bot metadata owns this link. Generic /bot/ anchors also include
  // navigation such as /bot/guides and /bot/use-cases, which are not templates.
  const metadata = html.replaceAll('\\"', '"');
  const ids = new Set(
    [...metadata.matchAll(/"addHref"\s*:\s*"\/bot\/([A-Za-z0-9_-]+)"/gu)]
      .map((match) => match[1]!)
      .filter((id) => id !== "marketplace" && SHARE_ID.test(id)),
  );
  if (ids.size !== 1) {
    throw new Error(
      ids.size
        ? "Ambiguous Grok Bot import links in marketplace page."
        : "Grok Bot marketplace page has no import link.",
    );
  }
  return [...ids][0]!;
}

export class GrokSourceHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads only public HTTPS and keeps a Grok credential on its exact API origin. */
export async function readGrokResponse(
  url: string,
  options: {
    token?: string;
    body?: Record<string, unknown>;
    limit?: number;
  } = {},
): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Grok download must use HTTPS without embedded credentials.");
  }
  if (options.token && parsed.origin !== "https://api2.cursor.sh") {
    throw new Error("Grok authentication may only be sent to its API origin.");
  }
  const { response, release } = await fetchWithSsrFGuard({
    url,
    timeoutMs: 30_000,
    maxRedirects: 0,
    auditContext: "migrate-grok",
    capture: false,
    init: {
      method: options.body ? "POST" : "GET",
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body
          ? { "content-type": "application/json", "connect-protocol-version": "1" }
          : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    },
  });
  try {
    if (response.status === 401) {
      throw new GrokSourceHttpError(
        401,
        "Grok access is required. Sign in to Grok Bot on this machine, or provide GROK_BOT_ACCESS_TOKEN in the environment.",
      );
    }
    if (response.status === 403) {
      throw new GrokSourceHttpError(
        403,
        "Grok refused access to this bot or operation. Check the account's access; signing in again may not resolve a permission restriction.",
      );
    }
    if (!response.ok) {
      throw new GrokSourceHttpError(
        response.status,
        `Grok download failed (HTTP ${response.status}).`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Grok returned an empty response.");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > (options.limit ?? MAX_RECIPE_BYTES)) {
          throw new Error("Grok response exceeds the import size limit.");
        }
        chunks.push(value);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    await release();
  }
}

export async function resolveGrokShareId(value: string): Promise<string> {
  const source = parseGrokBotUrl(value);
  return source.kind === "share"
    ? source.shareId
    : shareIdFromMarketplaceHtml(await readGrokResponse(source.url, { limit: 2 * 1024 * 1024 }));
}
