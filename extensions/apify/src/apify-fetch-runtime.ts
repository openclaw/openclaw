import {
  readResponseText,
  truncateText,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { APIFY_INTEGRATION_HEADERS, APIFY_PLUGIN_ID } from "./apify-shared.js";

const APIFY_CRAWLER_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items";

export type CrawlerType = "cheerio" | "playwright:firefox" | "playwright:adaptive";

type CrawlerResultItem = {
  url?: string;
  metadata?: {
    title?: string;
    description?: string;
    languageCode?: string;
    canonicalUrl?: string;
  };
  markdown?: string;
  text?: string;
};

function resolveMemoryMb(crawlerType: CrawlerType): number {
  return crawlerType.startsWith("playwright:") ? 4096 : 1024;
}

export async function executeApifyFetch(
  url: string,
  apiKey: string | undefined,
  crawlerType: CrawlerType,
  timeoutSeconds: number,
  maxChars?: number,
): Promise<Record<string, unknown>> {
  if (!apiKey) {
    throw new Error(
      "web_fetch (apify): missing Apify API token. Set APIFY_API_KEY in the environment or configure plugins.entries.apify.config.apiKey.",
    );
  }

  const start = Date.now();
  const memoryMb = resolveMemoryMb(crawlerType);
  const endpointUrl = `${APIFY_CRAWLER_ENDPOINT}?memory=${memoryMb}`;

  const items = await withTrustedWebToolsEndpoint<CrawlerResultItem[]>(
    {
      url: endpointUrl,
      timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...APIFY_INTEGRATION_HEADERS,
        },
        body: JSON.stringify({
          startUrls: [{ url }],
          crawlerType,
          maxCrawlDepth: 0,
          maxCrawlPages: 1,
          maxResults: 1,
          removeCookieWarnings: true,
          saveMarkdown: true,
          requestTimeoutSecs: timeoutSeconds,
        }),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detail = await readResponseText(response, { maxBytes: 64_000 });
        throw new Error(
          `Apify Website Content Crawler API error (${response.status}): ${detail.text || response.statusText}`,
        );
      }
      const data = (await response.json()) as CrawlerResultItem[];
      return Array.isArray(data) ? data : [];
    },
  );

  const item = items[0];
  if (!item) {
    throw new Error(`web_fetch (apify): Website Content Crawler returned no content for ${url}.`);
  }

  const title = item.metadata?.title ?? "";
  const rawContent = item.markdown ?? item.text ?? "";
  const content = maxChars !== undefined ? truncateText(rawContent, maxChars).text : rawContent;
  const fetchedUrl = item.url ?? url;

  return {
    url: fetchedUrl,
    provider: APIFY_PLUGIN_ID,
    tookMs: Date.now() - start,
    title: title ? wrapWebContent(title, "web_fetch") : "",
    text: content ? wrapWebContent(content, "web_fetch") : "",
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      provider: APIFY_PLUGIN_ID,
      wrapped: true,
    },
  };
}
