#!/usr/bin/env node
// Google Imagen 3 Image Generation — Node.js (22+)
// Usage: node generate-image.js --prompt "..." [--output dir] [--count N] [--aspect-ratio R]

import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    prompt: { type: "string", short: "p" },
    output: { type: "string", short: "o", default: "C:\\TEST\\generated-images" },
    count: { type: "string", short: "c", default: "1" },
    "aspect-ratio": { type: "string", short: "a", default: "1:1" },
    model: { type: "string", short: "m", default: "imagen-4.0-fast-generate-001" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help || !args.prompt) {
  console.log(`Usage: node generate-image.js --prompt "..." [options]
Options:
  -p, --prompt        Image description (required)
  -o, --output        Output directory (default: C:\\TEST\\generated-images)
  -c, --count         Number of images 1-4 (default: 1)
  -a, --aspect-ratio  1:1, 3:4, 4:3, 9:16, 16:9 (default: 1:1)
  -m, --model         Model name (default: imagen-3.0-generate-002)`);
  process.exit(args.help ? 0 : 1);
}

const prompt = args.prompt;
const outputDir = args.output;
const count = Math.min(4, Math.max(1, parseInt(args.count, 10) || 1));
const aspectRatio = args["aspect-ratio"];
const model = args.model;

// --- Load API key ---
const configPath = join(homedir(), ".openclaw", "openclaw.json");
let apiKey;
try {
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw);
  apiKey = config?.models?.providers?.google?.apiKey;
} catch (e) {
  console.error(`Failed to read config: ${configPath}`, e.message);
  process.exit(1);
}

if (!apiKey) {
  console.error("Google API key not found in openclaw.json (models.providers.google.apiKey)");
  process.exit(1);
}

// --- Ensure output dir ---
if (!existsSync(outputDir)) {
  await mkdir(outputDir, { recursive: true });
}

// --- Call API ---
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;

console.log(`[Nano Banana Pro] Generating ${count} image(s)...`);
console.log(`  Prompt: ${prompt}`);
console.log(`  Aspect: ${aspectRatio} | Model: ${model}`);

const res = await fetch(url, {
  method: "POST",
  headers: {
    "x-goog-api-key": apiKey,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    instances: [{ prompt }],
    parameters: { sampleCount: count, aspectRatio },
  }),
});

if (!res.ok) {
  const errText = await res.text();
  console.error(`API error (HTTP ${res.status}): ${errText}`);
  process.exit(1);
}

const data = await res.json();

if (!data.predictions?.length) {
  console.error("No predictions returned.", JSON.stringify(data, null, 2));
  process.exit(1);
}

// --- Save images ---
const now = new Date();
const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(".", "_");
const savedFiles = [];

for (let i = 0; i < data.predictions.length; i++) {
  const b64 = data.predictions[i].bytesBase64Encoded;
  if (!b64) {
    console.warn(`  Prediction ${i + 1}: no image data (safety-filtered?)`);
    continue;
  }
  const filename = `imagen_${ts}_${i + 1}.png`;
  const filePath = join(outputDir, filename);
  await writeFile(filePath, Buffer.from(b64, "base64"));
  savedFiles.push(filePath);
  console.log(`  Saved: ${filePath}`);
}

if (savedFiles.length === 0) {
  console.error("No images generated (all safety-filtered)");
  process.exit(1);
}

console.log(`\n[Done] Generated ${savedFiles.length} image(s):`);
savedFiles.forEach((f) => console.log(`  ${f}`));
