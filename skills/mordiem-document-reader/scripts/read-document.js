#!/usr/bin/env node
/**
 * Mordiem document/image reader.
 *
 * Usage:
 *   node read-document.js --path <file> [--prompt "..."] [--max-tokens 4096]
 *
 * Env: MORDIEM_API_KEY (injected by TabHR / OpenClaw at agent runtime)
 * Model: always deepseek-v4-flash (fixed)
 */

import fs from "node:fs";
import path from "node:path";

const API_URL = "https://api.mordiem.com/api/v1/chat/completions";
const MODEL = "deepseek-v4-flash";
const DEFAULT_PROMPT = "Read and summarize this document";
const DEFAULT_MAX_TOKENS = 4096;
const TIMEOUT_MS = 180_000;

const EXT_MIME = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".doc", "application/msword"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".xml", "application/xml"],
  [".html", "text/html"],
  [".htm", "text/html"],
]);

function printHelp() {
  console.log(`Usage: node read-document.js --path <file> [options]

Options:
  --path <file>       Path to document or image (required)
  --prompt <text>     Prompt for the model (default: "${DEFAULT_PROMPT}")
  --max-tokens <n>    Max response tokens (default: ${DEFAULT_MAX_TOKENS})
  --help              Show this help

Model: ${MODEL} (fixed)
Auth: MORDIEM_API_KEY (injected by TabHR / OpenClaw; do not pass manually)
`);
}

function parseArgs(argv) {
  const opts = {
    path: "",
    prompt: DEFAULT_PROMPT,
    maxTokens: DEFAULT_MAX_TOKENS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--path" && argv[i + 1]) {
      opts.path = argv[++i];
      continue;
    }
    if (arg === "--prompt" && argv[i + 1]) {
      opts.prompt = argv[++i];
      continue;
    }
    if (arg === "--max-tokens" && argv[i + 1]) {
      opts.maxTokens = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (!arg.startsWith("-") && !opts.path) {
      opts.path = arg;
    }
  }

  return opts;
}

function resolveMimeType(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  const fromExt = EXT_MIME.get(ext);
  if (fromExt) {
    return fromExt;
  }

  if (buffer.length >= 4) {
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return "application/pdf";
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "image/gif";
    }
  }

  return "application/octet-stream";
}

function isImageMime(mimeType) {
  return mimeType.startsWith("image/");
}

function buildContentBlock(filePath, buffer, mimeType) {
  const base64 = buffer.toString("base64");
  const filename = path.basename(filePath);

  if (isImageMime(mimeType)) {
    return {
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${base64}`,
      },
    };
  }

  return {
    type: "file",
    file: {
      filename,
      file_data: `data:${mimeType};base64,${base64}`,
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.path) {
    console.error("Error: --path is required");
    printHelp();
    process.exit(1);
  }

  const apiKey = process.env.MORDIEM_API_KEY;
  if (!apiKey) {
    console.error("Error: MORDIEM_API_KEY is not set (TabHR / OpenClaw should inject this at agent runtime)");
    process.exit(1);
  }

  const resolvedPath = path.resolve(opts.path);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: file not found: ${resolvedPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    console.error(`Error: not a file: ${resolvedPath}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(resolvedPath);
  const mimeType = resolveMimeType(resolvedPath, buffer);
  const fileBlock = buildContentBlock(resolvedPath, buffer, mimeType);

  const body = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: opts.prompt }],
      },
    ],
    max_tokens: opts.maxTokens,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${text}`);
      process.exit(1);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error("Error: invalid JSON response");
      console.error(text);
      process.exit(1);
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      console.error("Error: empty response from model");
      console.error(JSON.stringify(json, null, 2));
      process.exit(1);
    }

    process.stdout.write(`${content.trim()}\n`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`Error: request timed out after ${TIMEOUT_MS / 1000}s`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

main();
