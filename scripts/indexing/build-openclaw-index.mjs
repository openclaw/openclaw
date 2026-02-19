#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG = "scripts/indexing/openclaw-index.config.json";
const DEFAULT_OUT_DIR = ".openclaw-index";
const DOCS_PREFIX_BLOCK =
  /^> ## Documentation Index\n> Fetch the complete documentation index at: https:\/\/docs\.openclaw\.ai\/llms\.txt\n> Use this file to discover all available pages before exploring further\.\n*/;

function usage() {
  console.log(`OpenClaw local indexer\n\nUsage:\n  node scripts/indexing/build-openclaw-index.mjs [options]\n\nOptions:\n  --config <path>           Config JSON file (default: ${DEFAULT_CONFIG})\n  --out <dir>               Output directory (default: ${DEFAULT_OUT_DIR})\n  --code-root <path>        Extra code root (repeatable)\n  --docs-locales <list>     Comma list: en,zh-CN,ja-JP\n  --max-doc-pages <n>       Crawl cap override\n  --strict                  Exit non-zero on failed quality gates (default)\n  --no-strict               Always exit zero\n  --help                    Show this help\n`);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG,
    outDir: DEFAULT_OUT_DIR,
    strict: true,
    extraCodeRoots: [],
    docsLocales: null,
    maxDocPages: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    if (arg === "--config") {
      options.configPath = argv[++i];
      continue;
    }
    if (arg === "--out") {
      options.outDir = argv[++i];
      continue;
    }
    if (arg === "--code-root") {
      options.extraCodeRoots.push(argv[++i]);
      continue;
    }
    if (arg === "--docs-locales") {
      options.docsLocales = argv[++i]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--max-doc-pages") {
      options.maxDocPages = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--no-strict") {
      options.strict = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function expandHome(input) {
  if (!input) {
    return input;
  }
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function normalizeWhitespace(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLocale(docPath) {
  if (docPath.startsWith("zh-CN/")) {
    return "zh-CN";
  }
  if (docPath.startsWith("ja-JP/")) {
    return "ja-JP";
  }
  return "en";
}

function canonicalizeDocPath(raw, baseUrl) {
  if (!raw) {
    return null;
  }

  let value = raw.trim();
  if (!value) {
    return null;
  }

  if (value.startsWith("mailto:") || value.startsWith("tel:")) {
    return null;
  }

  if (value.startsWith(baseUrl)) {
    value = value.slice(baseUrl.length);
  }

  if (/^https?:\/\//.test(value)) {
    return null;
  }

  value = value.replace(/#.*/, "").replace(/\?.*/, "");
  value = decodeURIComponent(value);
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");

  if (value === "") {
    return "index";
  }

  value = value.replace(/\.md$/i, "").replace(/\/index$/i, "");
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");

  if (value === "") {
    return "index";
  }

  if (/^(cdn-cgi|_next|_mintlify|mintlify-assets)(\/|$)/.test(value)) {
    return null;
  }

  const blockedExt = /\.(png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|tar|gz|xml|json|txt|css|js)$/i;
  if (blockedExt.test(value)) {
    return null;
  }

  return value;
}

function docPathToMarkdownUrl(baseUrl, docPath) {
  if (docPath === "index") {
    return `${baseUrl}/index.md`;
  }
  return `${baseUrl}/${docPath}.md`;
}

function parseLlmsIndex(text, baseUrl) {
  const paths = new Set();
  const regex = new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}/[^)\\s]+`, "g");
  const matches = text.match(regex) ?? [];
  for (const match of matches) {
    const normalized = canonicalizeDocPath(match, baseUrl);
    if (normalized) {
      paths.add(normalized);
    }
  }
  return paths;
}

function parseSitemapXml(xml, baseUrl) {
  const paths = new Set();
  const lastmodByPath = new Map();

  const urlBlockRegex = /<url>([\s\S]*?)<\/url>/g;
  let blockMatch;
  while ((blockMatch = urlBlockRegex.exec(xml))) {
    const block = blockMatch[1];
    const locMatch = block.match(/<loc>(.*?)<\/loc>/);
    if (!locMatch) {
      continue;
    }
    const docPath = canonicalizeDocPath(locMatch[1], baseUrl);
    if (!docPath) {
      continue;
    }
    paths.add(docPath);

    const lastmodMatch = block.match(/<lastmod>(.*?)<\/lastmod>/);
    if (lastmodMatch) {
      lastmodByPath.set(docPath, lastmodMatch[1]);
    }
  }

  return { paths, lastmodByPath };
}

function extractTitle(content) {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim();
    }
  }
  return null;
}

function cleanDocContent(content) {
  let next = normalizeWhitespace(content);
  next = next.replace(DOCS_PREFIX_BLOCK, "").trim();

  const lines = next.split("\n");
  if (lines.length >= 2 && lines[0].startsWith("# ") && lines[1].trim() === "") {
    const firstHeading = lines[0].trim();
    for (let i = 2; i < Math.min(lines.length, 8); i += 1) {
      if (lines[i].trim() === firstHeading) {
        lines.splice(i, 1);
        break;
      }
      if (lines[i].startsWith("## ")) {
        break;
      }
    }
    next = lines.join("\n");
  }

  return next.trim();
}

function extractInternalDocLinks(markdown, baseUrl) {
  const links = new Set();
  const patterns = [/\[[^\]]*\]\(([^)]+)\)/g, /href="([^"]+)"/g];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(markdown))) {
      const value = match[1];
      if (!(value.startsWith("/") || value.startsWith(baseUrl))) {
        continue;
      }
      const normalized = canonicalizeDocPath(value, baseUrl);
      if (normalized) {
        links.add(normalized);
      }
    }
  }

  return links;
}

async function fetchTextWithRetries(url, requestOptions) {
  const {
    timeoutMs = 15000,
    retries = 3,
    backoffMs = 400,
    headers = {},
    accept = "text/plain,text/markdown,text/xml;q=0.9,*/*;q=0.8",
  } = requestOptions;

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept,
          ...headers,
        },
        signal: abortController.signal,
      });

      const text = await response.text();
      const responseHeaders = {};
      for (const [key, value] of response.headers.entries()) {
        responseHeaders[key.toLowerCase()] = value;
      }

      clearTimeout(timeout);

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          text,
          headers: responseHeaders,
          finalUrl: response.url,
        };
      }

      lastError = new Error(`HTTP ${response.status} at ${url}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }

  return {
    ok: false,
    status: null,
    text: null,
    headers: {},
    finalUrl: url,
    error: lastError ? String(lastError.message ?? lastError) : "unknown fetch error",
  };
}

function chunkText(content, { chunkLines, overlapLines }) {
  const normalized = normalizeWhitespace(content);
  const lines = normalized.split("\n");

  if (lines.length === 0) {
    return [];
  }

  const records = [];
  let start = 0;
  const step = Math.max(1, chunkLines - overlapLines);

  while (start < lines.length) {
    const end = Math.min(lines.length, start + chunkLines);
    const chunkLinesSlice = lines.slice(start, end);
    records.push({
      startLine: start + 1,
      endLine: end,
      text: chunkLinesSlice.join("\n").trim(),
    });

    if (end >= lines.length) {
      break;
    }

    start += step;
  }

  return records.filter((chunk) => chunk.text.length > 0);
}

function sanitizeForIndexing(content) {
  let text = normalizeWhitespace(content);

  text = text.replace(
    /(["']?(?:api[_-]?key|token|secret|password|authorization|cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1\"[REDACTED]\"",
  );

  text = text.replace(
    /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|BRAVE_API_KEY|FIRECRAWL_API_KEY|OPENROUTER_API_KEY|DISCORD_BOT_TOKEN|TELEGRAM_BOT_TOKEN)\s*=\s*[^\s]+/g,
    "$1=[REDACTED]",
  );

  text = text.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
  return text;
}

function shouldIndexCodeFile(filePath, includeExtensions) {
  const ext = path.extname(filePath).toLowerCase();
  return includeExtensions.includes(ext);
}

async function isProbablyTextFile(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] === 0) {
        return false;
      }
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function walkFiles(rootPath, excludeDirs) {
  const files = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        if (entry.name === ".env") {
          const full = path.join(current, entry.name);
          files.push(full);
        }
        continue;
      }

      const fullPath = path.join(current, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function indexCode(config, repoRoot, failures) {
  const codeConfig = config.code;
  const excludeDirs = new Set(codeConfig.excludeDirs);
  const includeExtensions = codeConfig.includeExtensions.map((ext) => ext.toLowerCase());
  const chunkCfg = { chunkLines: codeConfig.chunkLines, overlapLines: codeConfig.chunkOverlap };

  const records = [];
  const filesIndexed = [];

  for (const rootCandidate of codeConfig.roots) {
    const resolvedRoot = path.resolve(repoRoot, expandHome(rootCandidate));
    try {
      const stat = await fs.stat(resolvedRoot);
      if (!stat.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const allFiles = await walkFiles(resolvedRoot, excludeDirs);

    for (const filePath of allFiles) {
      if (!shouldIndexCodeFile(filePath, includeExtensions)) {
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        failures.push({ kind: "code", path: filePath, error: String(error.message ?? error) });
        continue;
      }

      if (stat.size > codeConfig.maxFileBytes) {
        continue;
      }

      const isText = await isProbablyTextFile(filePath);
      if (!isText) {
        continue;
      }

      let content;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch (error) {
        failures.push({ kind: "code", path: filePath, error: String(error.message ?? error) });
        continue;
      }

      const relativeRoot = path.relative(repoRoot, resolvedRoot) || ".";
      const relativePath = path.relative(resolvedRoot, filePath);
      const sourcePath = path.join(relativeRoot, relativePath);

      const chunks = chunkText(content, chunkCfg);
      const fileHash = hashText(content);
      filesIndexed.push(sourcePath);

      chunks.forEach((chunk, index) => {
        records.push({
          id: `code:${sourcePath}:${index + 1}`,
          kind: "code",
          source: sourcePath,
          locale: null,
          title: path.basename(filePath),
          hash: fileHash,
          chunk: {
            index: index + 1,
            total: chunks.length,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          },
          metadata: {
            root: relativeRoot,
            extension: path.extname(filePath).toLowerCase(),
            sizeBytes: stat.size,
            mtime: stat.mtime.toISOString(),
          },
          content: chunk.text,
        });
      });
    }
  }

  return {
    records,
    filesIndexed: new Set(filesIndexed),
  };
}

async function collectRuntimeFiles(runtimeConfig, failures) {
  const root = path.resolve(expandHome(runtimeConfig.homeStateDir));
  const excludeDirs = new Set(runtimeConfig.excludeDirs);
  const includePatterns = runtimeConfig.includeFilePatterns.map((pattern) => new RegExp(pattern));
  const maxDepth = runtimeConfig.maxDepth;
  const results = [];

  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return results;
    }
  } catch {
    return results;
  }

  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await fs.readdir(current.dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || current.depth >= maxDepth) {
          continue;
        }
        queue.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const include = includePatterns.some((pattern) => pattern.test(entry.name));
      if (!include) {
        continue;
      }

      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > 1024 * 1024) {
          continue;
        }
        results.push(fullPath);
      } catch (error) {
        failures.push({ kind: "runtime", path: fullPath, error: String(error.message ?? error) });
      }
    }
  }

  return results;
}

async function indexRuntime(config, repoRoot, failures) {
  const runtimeFiles = await collectRuntimeFiles(config.runtime, failures);
  const records = [];
  const chunkCfg = { chunkLines: 220, overlapLines: 40 };

  for (const filePath of runtimeFiles) {
    let content;
    let stat;
    try {
      stat = await fs.stat(filePath);
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      failures.push({ kind: "runtime", path: filePath, error: String(error.message ?? error) });
      continue;
    }

    const redacted = sanitizeForIndexing(content);
    const relativePath = filePath.startsWith(os.homedir())
      ? `~/${path.relative(os.homedir(), filePath)}`
      : path.relative(repoRoot, filePath);

    const chunks = chunkText(redacted, chunkCfg);
    const fileHash = hashText(redacted);

    chunks.forEach((chunk, index) => {
      records.push({
        id: `runtime:${relativePath}:${index + 1}`,
        kind: "runtime",
        source: relativePath,
        locale: null,
        title: path.basename(filePath),
        hash: fileHash,
        chunk: {
          index: index + 1,
          total: chunks.length,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        },
        metadata: {
          mtime: stat.mtime.toISOString(),
          sizeBytes: stat.size,
          redacted: true,
        },
        content: chunk.text,
      });
    });
  }

  return {
    records,
    filesIndexed: new Set(runtimeFiles),
  };
}

async function indexConfigDocs(config, repoRoot, failures) {
  const files = config.configDocs.files;
  const records = [];
  const filesIndexed = new Set();
  const chunkCfg = { chunkLines: 220, overlapLines: 40 };

  for (const relativeDocPath of files) {
    const absoluteDocPath = path.resolve(repoRoot, relativeDocPath);
    try {
      const stat = await fs.stat(absoluteDocPath);
      if (!stat.isFile()) {
        continue;
      }
      const content = await fs.readFile(absoluteDocPath, "utf8");
      const chunks = chunkText(content, chunkCfg);
      const fileHash = hashText(content);
      filesIndexed.add(relativeDocPath);

      chunks.forEach((chunk, index) => {
        records.push({
          id: `config-doc:${relativeDocPath}:${index + 1}`,
          kind: "config-doc",
          source: relativeDocPath,
          locale: null,
          title: path.basename(relativeDocPath),
          hash: fileHash,
          chunk: {
            index: index + 1,
            total: chunks.length,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          },
          metadata: {
            mtime: stat.mtime.toISOString(),
            sizeBytes: stat.size,
          },
          content: chunk.text,
        });
      });
    } catch (error) {
      failures.push({
        kind: "config-doc",
        path: relativeDocPath,
        error: String(error.message ?? error),
      });
    }
  }

  return { records, filesIndexed };
}

async function buildDocsIndex(config, failures) {
  const docsCfg = config.docs;
  const allowedLocales = new Set(docsCfg.allowedLocales);
  const pathSignals = new Map();
  const sitemapLastmod = new Map();
  const llmsPaths = new Set();
  const sitemapPaths = new Set();

  const llmsUrl = `${docsCfg.baseUrl}${docsCfg.llmsPath}`;
  const sitemapUrl = `${docsCfg.baseUrl}${docsCfg.sitemapPath}`;

  const llmsResult = await fetchTextWithRetries(llmsUrl, {
    timeoutMs: docsCfg.requestTimeoutMs,
    retries: docsCfg.requestRetries,
    backoffMs: docsCfg.requestBackoffMs,
    accept: "text/plain,*/*",
  });

  if (!llmsResult.ok) {
    failures.push({ kind: "docs-seed", source: llmsUrl, error: llmsResult.error });
  } else {
    const parsed = parseLlmsIndex(llmsResult.text, docsCfg.baseUrl);
    for (const docPath of parsed) {
      llmsPaths.add(docPath);
      if (!pathSignals.has(docPath)) {
        pathSignals.set(docPath, new Set());
      }
      pathSignals.get(docPath).add("llms");
    }
  }

  const sitemapResult = await fetchTextWithRetries(sitemapUrl, {
    timeoutMs: docsCfg.requestTimeoutMs,
    retries: docsCfg.requestRetries,
    backoffMs: docsCfg.requestBackoffMs,
    accept: "text/xml,*/*",
  });

  if (!sitemapResult.ok) {
    failures.push({ kind: "docs-seed", source: sitemapUrl, error: sitemapResult.error });
  } else {
    const parsed = parseSitemapXml(sitemapResult.text, docsCfg.baseUrl);
    for (const docPath of parsed.paths) {
      sitemapPaths.add(docPath);
      if (!pathSignals.has(docPath)) {
        pathSignals.set(docPath, new Set());
      }
      pathSignals.get(docPath).add("sitemap");
    }
    for (const [docPath, lastmod] of parsed.lastmodByPath.entries()) {
      sitemapLastmod.set(docPath, lastmod);
    }
  }

  if (!pathSignals.has("index")) {
    pathSignals.set("index", new Set(["seed"]));
  }

  const queue = [...pathSignals.keys()].sort();
  const seen = new Set();
  const pages = new Map();
  const requested = [];
  const fetchConcurrency = Math.max(1, Number.parseInt(String(docsCfg.fetchConcurrency ?? 8), 10) || 8);
  let successfulFetches = 0;

  while (queue.length > 0 && seen.size < docsCfg.crawlMaxPages) {
    const batch = [];

    while (batch.length < fetchConcurrency && queue.length > 0 && seen.size < docsCfg.crawlMaxPages) {
      const requestedPath = queue.shift();
      if (!requestedPath) {
        continue;
      }
      if (seen.has(requestedPath)) {
        continue;
      }
      const locale = detectLocale(requestedPath);
      if (!allowedLocales.has(locale)) {
        continue;
      }
      seen.add(requestedPath);
      batch.push(requestedPath);
    }

    if (batch.length === 0) {
      continue;
    }

    const batchResults = await Promise.all(
      batch.map(async (requestedPath) => {
        const requestedUrl = docPathToMarkdownUrl(docsCfg.baseUrl, requestedPath);
        requested.push(requestedUrl);
        const response = await fetchTextWithRetries(requestedUrl, {
          timeoutMs: docsCfg.requestTimeoutMs,
          retries: docsCfg.requestRetries,
          backoffMs: docsCfg.requestBackoffMs,
          accept: "text/markdown,text/plain,*/*",
        });

        return { requestedPath, requestedUrl, response };
      }),
    );

    for (const { requestedPath, requestedUrl, response } of batchResults) {
      if (!response.ok) {
        failures.push({
          kind: "docs-page",
          source: requestedUrl,
          error: response.error,
          status: response.status,
        });
        continue;
      }

      const contentType = response.headers["content-type"] ?? "";
      if (!contentType.toLowerCase().includes("markdown")) {
        failures.push({
          kind: "docs-page",
          source: requestedUrl,
          error: `expected markdown content-type, got ${contentType || "unknown"}`,
        });
        continue;
      }

      successfulFetches += 1;
      if (successfulFetches % 50 === 0) {
        console.log(
          `[indexer] docs crawl progress: ${successfulFetches} pages fetched, ${queue.length} queued`,
        );
      }

      const finalPath = canonicalizeDocPath(response.finalUrl, docsCfg.baseUrl) ?? requestedPath;
      if (!pathSignals.has(finalPath)) {
        pathSignals.set(finalPath, new Set());
      }

      const requestedSignals = pathSignals.get(requestedPath) ?? new Set();
      const finalSignals = pathSignals.get(finalPath);
      for (const signal of requestedSignals) {
        finalSignals.add(signal);
      }

      const cleaned = cleanDocContent(response.text);
      const title = extractTitle(cleaned);
      const links = extractInternalDocLinks(cleaned, docsCfg.baseUrl);

      for (const linkedPath of links) {
        const linkedLocale = detectLocale(linkedPath);
        if (!allowedLocales.has(linkedLocale)) {
          continue;
        }
        if (!pathSignals.has(linkedPath)) {
          pathSignals.set(linkedPath, new Set(["linkcrawl"]));
        } else {
          pathSignals.get(linkedPath).add("linkcrawl");
        }
        if (!seen.has(linkedPath)) {
          queue.push(linkedPath);
        }
      }

      const pageKey = finalPath;
      const existing = pages.get(pageKey);
      if (!existing) {
        pages.set(pageKey, {
          path: pageKey,
          locale: detectLocale(pageKey),
          title,
          content: cleaned,
          url: docPathToMarkdownUrl(docsCfg.baseUrl, pageKey),
          signals: new Set(pathSignals.get(pageKey) ?? []),
          lastModified: response.headers["last-modified"] ?? null,
          sitemapLastmod: sitemapLastmod.get(pageKey) ?? null,
          contentType,
        });
      }
    }
  }

  const docsRecords = [];
  const docsChunks = { chunkLines: 220, overlapLines: 40 };

  for (const page of [...pages.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const chunks = chunkText(page.content, docsChunks);
    const pageHash = hashText(page.content);

    chunks.forEach((chunk, index) => {
      docsRecords.push({
        id: `doc:${page.path}:${index + 1}`,
        kind: "doc",
        source: page.path,
        locale: page.locale,
        title: page.title,
        hash: pageHash,
        chunk: {
          index: index + 1,
          total: chunks.length,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        },
        metadata: {
          url: page.url,
          discoveredBy: [...(page.signals ?? [])].sort(),
          lastModified: page.lastModified,
          sitemapLastmod: page.sitemapLastmod,
          contentType: page.contentType,
        },
        content: chunk.text,
      });
    });
  }

  const discoveredPaths = new Set([...pages.keys()]);
  const hiddenPaths = [...discoveredPaths].filter(
    (docPath) => !llmsPaths.has(docPath) && !sitemapPaths.has(docPath),
  );

  const englishSitemapPaths = [...sitemapPaths].filter((docPath) => detectLocale(docPath) === "en");
  const englishDiscoveredPaths = [...discoveredPaths].filter((docPath) => detectLocale(docPath) === "en");
  const englishSitemapMissingFromCrawl = englishSitemapPaths.filter(
    (docPath) => !discoveredPaths.has(docPath),
  );
  const englishDiscoveredNotInSitemap = englishDiscoveredPaths.filter(
    (docPath) => !sitemapPaths.has(docPath),
  );

  return {
    records: docsRecords,
    summary: {
      requestedPages: requested.length,
      indexedPages: pages.size,
      llmsCount: llmsPaths.size,
      sitemapCount: sitemapPaths.size,
      hiddenCount: hiddenPaths.length,
      hiddenPaths: hiddenPaths.sort(),
      englishSitemapMissingFromCrawl: englishSitemapMissingFromCrawl.sort(),
      englishDiscoveredNotInSitemap: englishDiscoveredNotInSitemap.sort(),
    },
  };
}

function mergeConfig(baseConfig, overrides) {
  const next = structuredClone(baseConfig);

  if (overrides.docsLocales && overrides.docsLocales.length > 0) {
    next.docs.allowedLocales = overrides.docsLocales;
  }

  if (typeof overrides.maxDocPages === "number" && Number.isFinite(overrides.maxDocPages)) {
    next.docs.crawlMaxPages = Math.max(1, overrides.maxDocPages);
  }

  if (overrides.extraCodeRoots?.length > 0) {
    next.code.roots = [...next.code.roots, ...overrides.extraCodeRoots];
  }

  next.code.roots = [...new Set(next.code.roots)];

  return next;
}

function countByKind(records) {
  const counts = {};
  for (const record of records) {
    counts[record.kind] = (counts[record.kind] ?? 0) + 1;
  }
  return counts;
}

function collectUniqueSources(records, kind) {
  const values = new Set();
  for (const record of records) {
    if (record.kind === kind) {
      values.add(record.source);
    }
  }
  return values;
}

function runQualityGates(config, metrics) {
  const gates = config.qualityGates;
  const failures = [];
  const warnings = [];

  if (metrics.docsIndexedPages < gates.minDocsPages) {
    failures.push(`docs pages ${metrics.docsIndexedPages} < minDocsPages ${gates.minDocsPages}`);
  }

  if (metrics.codeFiles < gates.minCodeFiles) {
    failures.push(`code files ${metrics.codeFiles} < minCodeFiles ${gates.minCodeFiles}`);
  }

  if (metrics.runtimeFiles < gates.minRuntimeFiles) {
    failures.push(`runtime files ${metrics.runtimeFiles} < minRuntimeFiles ${gates.minRuntimeFiles}`);
  }

  if (metrics.docFailureRate > gates.maxDocFailureRate) {
    failures.push(
      `doc failure rate ${metrics.docFailureRate.toFixed(3)} > maxDocFailureRate ${gates.maxDocFailureRate}`,
    );
  }

  if (metrics.hiddenDocs > gates.maxHiddenDocsWarning) {
    warnings.push(
      `detected ${metrics.hiddenDocs} docs via link-crawl that are missing from llms/sitemap manifests`,
    );
  }

  return { failures, warnings };
}

async function writeJsonl(filePath, records) {
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(filePath, payload.length > 0 ? `${payload}\n` : "", "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const repoRoot = process.cwd();
  const configPath = path.resolve(repoRoot, args.configPath);
  const outDir = path.resolve(repoRoot, args.outDir);

  const configRaw = await fs.readFile(configPath, "utf8");
  const parsedConfig = JSON.parse(configRaw);
  const config = mergeConfig(parsedConfig, args);

  await fs.mkdir(outDir, { recursive: true });

  const failures = [];

  console.log("[indexer] indexing docs.openclaw.ai ...");
  const docsIndex = await buildDocsIndex(config, failures);

  console.log("[indexer] indexing local code roots ...");
  const codeIndex = await indexCode(config, repoRoot, failures);

  console.log("[indexer] indexing runtime/config state ...");
  const runtimeIndex = await indexRuntime(config, repoRoot, failures);

  console.log("[indexer] indexing runtime/config docs ...");
  const configDocsIndex = await indexConfigDocs(config, repoRoot, failures);

  const records = [
    ...docsIndex.records,
    ...codeIndex.records,
    ...runtimeIndex.records,
    ...configDocsIndex.records,
  ];

  records.sort((a, b) => a.id.localeCompare(b.id));

  const countsByKind = countByKind(records);
  const docsFailures = failures.filter((item) => item.kind.startsWith("docs")).length;
  const docsRequested = Math.max(1, docsIndex.summary.requestedPages);
  const docFailureRate = docsFailures / docsRequested;

  const metrics = {
    docsIndexedPages: docsIndex.summary.indexedPages,
    codeFiles: codeIndex.filesIndexed.size,
    runtimeFiles: runtimeIndex.filesIndexed.size,
    configDocFiles: configDocsIndex.filesIndexed.size,
    hiddenDocs: docsIndex.summary.hiddenCount,
    docFailureRate,
  };

  const gateResults = runQualityGates(config, metrics);

  const manifest = {
    generatedAt: new Date().toISOString(),
    repositoryRoot: repoRoot,
    configPath,
    outputDir: outDir,
    counts: {
      records: records.length,
      byKind: countsByKind,
      sources: {
        docs: collectUniqueSources(records, "doc").size,
        code: collectUniqueSources(records, "code").size,
        runtime: collectUniqueSources(records, "runtime").size,
        configDocs: collectUniqueSources(records, "config-doc").size,
      },
    },
    docs: docsIndex.summary,
    quality: {
      strict: args.strict,
      metrics,
      failures: gateResults.failures,
      warnings: gateResults.warnings,
    },
    failureCount: failures.length,
  };

  await writeJsonl(path.join(outDir, "documents.jsonl"), records);
  await writeJsonl(path.join(outDir, "failures.jsonl"), failures);
  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`[indexer] wrote ${records.length} records to ${path.join(outDir, "documents.jsonl")}`);
  console.log(`[indexer] docs pages indexed: ${metrics.docsIndexedPages}`);
  console.log(`[indexer] code files indexed: ${metrics.codeFiles}`);
  console.log(`[indexer] runtime files indexed: ${metrics.runtimeFiles}`);
  console.log(`[indexer] hidden docs detected: ${metrics.hiddenDocs}`);
  console.log(`[indexer] quality warnings: ${gateResults.warnings.length}`);
  console.log(`[indexer] quality failures: ${gateResults.failures.length}`);

  if (gateResults.failures.length > 0 && args.strict) {
    console.error("[indexer] strict mode enabled; failing due to quality gate errors");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[indexer] fatal: ${error.stack ?? error}`);
  process.exit(1);
});
