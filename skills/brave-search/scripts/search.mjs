#!/usr/bin/env node

function usage() {
  console.error(`Usage: search.mjs "query" [-n 5] [--content]`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage();

const query = args[0];
let n = 5;
let withContent = false;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "-n") {
    n = Number.parseInt(args[i + 1] ?? "5", 10);
    i++;
    continue;
  }
  if (a === "--content") {
    withContent = true;
    continue;
  }
  console.error(`Unknown arg: ${a}`);
  usage();
}

const apiKey = (process.env.BRAVE_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("Missing BRAVE_API_KEY");
  process.exit(1);
}

const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
endpoint.searchParams.set("q", query);
endpoint.searchParams.set("count", String(Math.max(1, Math.min(n, 20))));
endpoint.searchParams.set("text_decorations", "false");
endpoint.searchParams.set("safesearch", "moderate");

const resp = await fetch(endpoint, {
  headers: {
    Accept: "application/json",
    "X-Subscription-Token": apiKey,
  },
});

if (!resp.ok) {
  const text = await resp.text().catch(() => "");
  throw new Error(`Brave Search failed (${resp.status}): ${text}`);
}

const data = await resp.json();
const results = (data?.web?.results ?? []).slice(0, n);

const lines = [];
for (const r of results) {
  const title = String(r?.title ?? "").trim();
  const url = String(r?.url ?? "").trim();
  const desc = String(r?.description ?? "").trim();
  if (!title || !url) continue;
  lines.push(`- ${title}\n  ${url}${desc ? `\n  ${desc}` : ""}`);
}

process.stdout.write(lines.join("\n\n") + "\n");

if (!withContent) process.exit(0);

process.stdout.write("\n---\n\n");
for (const r of results) {
  const title = String(r?.title ?? "").trim();
  const url = String(r?.url ?? "").trim();
  if (!url) continue;
  process.stdout.write(`# ${title || url}\n${url}\n\n`);
  const child = await import("./content.mjs");
  const text = await child.fetchAsMarkdown(url);
  process.stdout.write(text.trimEnd() + "\n\n");
}
