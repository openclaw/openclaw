#!/usr/bin/env node

function usage() {
  console.error(`Usage: content.mjs <url>`);
  process.exit(2);
}

export async function fetchAsMarkdown(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "clawdbot-brave-search/1.0" },
  });
  const html = await resp.text();

  // Very lightweight “readability-ish” extraction without dependencies:
  // - drop script/style/nav/footer
  // - strip tags
  // - keep paragraphs
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (!resp.ok) {
    return `> Fetch failed (${resp.status}).\n\n${cleaned.slice(0, 2000)}\n`;
  }

  const paras = cleaned
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 30);

  return paras.map((p) => `- ${p}`).join("\n") + "\n";
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage();
const url = args[0];
process.stdout.write(await fetchAsMarkdown(url));
