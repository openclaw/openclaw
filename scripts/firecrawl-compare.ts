import { extractReadableContent, fetchFirecrawlContent } from "../src/agents/tools/web-tools.js";

const DEFAULT_URLS = [
  "https://en.wikipedia.org/wiki/Web_scraping",
  "https://news.ycombinator.com/",
  "https://www.apple.com/iphone/",
  "https://www.nytimes.com/",
  "https://www.reddit.com/r/javascript/",
];

const urls = process.argv.slice(2);
const targets = urls.length > 0 ? urls : DEFAULT_URLS;
const apiKey = process.env.FIRECRAWL_API_KEY;
const baseUrl = process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev";

const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const timeoutMs = 30_000;

function truncate(value: string, max = 180): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function fetchHtml(url: string): Promise<{
  ok: boolean;
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "*/*", "User-Agent": userAgent },
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType,
      finalUrl: res.url || url,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  if (!apiKey) {
    console.log("FIRECRAWL_API_KEY not set. Firecrawl comparisons will be skipped.");
  }

  for (const url of targets) {
    console.log(`\n=== ${url}`);
    let localStatus = "skipped";
    let localTitle = "";
    let localText = "";
    let localError: string | undefined;

    try {
      const res = await fetchHtml(url);
      if (!res.ok) {
        localStatus = `http ${res.status}`;
      } else if (!res.contentType.includes("text/html")) {
        localStatus = `non-html (${res.contentType})`;
      } else {
        const readable = await extractReadableContent({
          html: res.body,
          url: res.finalUrl,
          extractMode: "markdown",
        });
        if (readable?.text) {
          localStatus = "readability";
          localTitle = readable.title ?? "";
          localText = readable.text;
        } else {
          localStatus = "readability-empty";
        }
      }
    } catch (error) {
      localStatus = "error";
      localError = error instanceof Error ? error.message : String(error);
    }

    console.log(
      `local: ${localStatus} len=${localText.length} title=${truncate(localTitle, 80)}`
    );
    if (localError) console.log(`local error: ${localError}`);
    if (localText) console.log(`local sample: ${truncate(localText)}`);

    if (apiKey) {
      try {
        const firecrawl = await fetchFirecrawlContent({
          url,
          extractMode: "markdown",
          apiKey,
          baseUrl,
          onlyMainContent: true,
          maxAgeMs: 172_800_000,
          proxy: "auto",
          storeInCache: true,
          timeoutSeconds: 60,
        });
        console.log(
          `firecrawl: ok len=${firecrawl.text.length} title=${truncate(
            firecrawl.title ?? "",
            80,
          )} status=${firecrawl.status ?? "n/a"}`
        );
        if (firecrawl.warning) console.log(`firecrawl warning: ${firecrawl.warning}`);
        if (firecrawl.text) console.log(`firecrawl sample: ${truncate(firecrawl.text)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`firecrawl: error ${message}`);
      }
    }
  }

  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
