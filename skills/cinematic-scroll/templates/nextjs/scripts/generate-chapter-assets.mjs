#!/usr/bin/env node
/**
 * Batch chapter-asset generator.
 *
 * Reads `lib/editions-manifest.ts`, calls fal.ai for each chapter's hero image,
 * and writes the output URLs into `public/generated/manifest.json` plus
 * downloads the binary to `public/generated/<id>.webp` (or whatever format
 * the chosen model returns).
 *
 * Usage:
 *   node scripts/generate-chapter-assets.mjs              # generate all chapters
 *   node scripts/generate-chapter-assets.mjs --dry-run    # print prompts only
 *   node scripts/generate-chapter-assets.mjs --only prologue,studio
 *   node scripts/generate-chapter-assets.mjs --model fal-ai/gemini-3-pro-image-preview
 *
 * Requires:
 *   FAL_KEY=key_id:key_secret   (in .env.local)
 *   FAL_IMAGE_MODEL=fal-ai/flux-2-pro   (optional override)
 *
 * NOTE: this is a Node script (not Next runtime) so we use the raw HTTP
 * endpoint at https://fal.run/<model-id> with the key directly. We do NOT
 * use the proxy — the proxy is only for browser → server calls.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, env, exit } from 'node:process';

// ─── arg parsing ──────────────────────────────────────────────────────────

const args = argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
  only: (args.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '')
    .split(',')
    .filter(Boolean),
  model: args.find((a) => a.startsWith('--model='))?.split('=')[1],
};

// `--only foo,bar` (space form)
const onlyIdx = args.indexOf('--only');
if (onlyIdx !== -1 && args[onlyIdx + 1] && !args[onlyIdx + 1].startsWith('--')) {
  flags.only = args[onlyIdx + 1].split(',').filter(Boolean);
}
const modelIdx = args.indexOf('--model');
if (modelIdx !== -1 && args[modelIdx + 1] && !args[modelIdx + 1].startsWith('--')) {
  flags.model = args[modelIdx + 1];
}

// ─── env ──────────────────────────────────────────────────────────────────

const FAL_KEY = env.FAL_KEY;
const MODEL_ID = flags.model ?? env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-2-pro';

if (!FAL_KEY && !flags.dryRun) {
  console.error('\n[generate-chapter-assets] FAL_KEY missing. Set it in .env.local or your shell.\n');
  exit(1);
}

// ─── load .env.local manually (so the script works without `dotenv`) ──────

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

try {
  const envText = await (await import('node:fs/promises')).readFile(
    resolve(projectRoot, '.env.local'),
    'utf8',
  );
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch {
  // .env.local optional
}

// ─── per-model input builder (mirrors lib/fal-models.ts) ──────────────────

const FLUX_IMAGE_SIZE = { landscape: 'landscape_16_9', portrait: 'portrait_4_3', square: 'square_hd' };
const GEMINI_ASPECT = { landscape: '16:9', portrait: '3:4', square: '1:1' };

function buildInput(modelId, prompt, orientation) {
  if (modelId.startsWith('fal-ai/flux')) {
    return {
      prompt,
      image_size: FLUX_IMAGE_SIZE[orientation],
      output_format: 'jpeg',
      enable_safety_checker: true,
      safety_tolerance: '2',
    };
  }
  if (modelId.startsWith('fal-ai/gemini')) {
    return {
      prompt,
      aspect_ratio: GEMINI_ASPECT[orientation],
      output_format: 'png',
      resolution: '1K',
      num_images: 1,
      safety_tolerance: '4',
    };
  }
  // imagen + fallback
  return {
    prompt,
    aspect_ratio: GEMINI_ASPECT[orientation],
    num_images: 1,
  };
}

// ─── prompt builder (mirrors lib/prompt-contract.ts) ──────────────────────

const HISTORICAL = {
  renaissance: 'Renaissance composition: layered chiaroscuro, dramatic fabric, sfumato edges, museum-grade lighting.',
  baroque: 'Baroque composition: theatrical movement, deep shadow contrast, gilded textures, dynamic diagonals.',
  atelier: 'Painterly atelier composition: visible brushwork, warm sepia base, soft natural studio light.',
  architectural: 'Architectural drafting composition: orthographic clarity, parchment tones, fine ink lines.',
  industrial: 'Industrial-era composition: forged metal, oxidised brass, steam-warm light, mechanical detail.',
};

const CAMERA = {
  wide: 'Wide cinematic shot, deep field, atmospheric perspective.',
  medium: 'Medium shot, balanced subject framing.',
  macro: 'Macro detail shot, shallow depth of field, tactile material focus.',
  isometric: 'Clean isometric projection, technical clarity, even lighting.',
  'low-angle': 'Low-angle hero shot, monumental perspective.',
};

const AVOID =
  'brand logos, unreadable text overlays, fake UI labels, watermarks, low resolution, distorted hands, generic AI gloss';

function buildPrompt(vp) {
  return [
    'Original editorial product-scene image for a high-craft interactive release website.',
    `Scene: ${vp.subject}.`,
    `Product truth: ${vp.productTruth}.`,
    HISTORICAL[vp.historicalLayer],
    `Modern layer: ${vp.modernLayer} — integrated naturally, not stickered on.`,
    `Palette: ${vp.palette.join(', ')}.`,
    CAMERA[vp.camera],
    'Background plate. Subject de-emphasised, atmosphere primary, suitable for radial vignette overlay.',
    'No brand logos, no readable text, no imitation of named living artists.',
    `Avoid: ${AVOID}.`,
  ].join(' ');
}

// ─── load chapters from the TS manifest at runtime via tiny regex ─────────
// We avoid `ts-node` so the script stays dependency-free. Chapters are
// exported as a `const editionChapters` array literal — readable by JSON.parse
// after light cleanup.

async function loadChapters() {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(resolve(projectRoot, 'lib/editions-manifest.ts'), 'utf8');
  const m = src.match(/export const editionChapters[^=]*=\s*(\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('Could not locate editionChapters in lib/editions-manifest.ts');
  // Strip TS-only bits: trailing commas, single quotes, keys without quotes.
  const jsonish = m[1]
    .replace(/'/g, '"')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  return JSON.parse(jsonish);
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  const chapters = await loadChapters();
  const targets = flags.only.length ? chapters.filter((c) => flags.only.includes(c.id)) : chapters;

  console.log(`\n[generate-chapter-assets] model=${MODEL_ID}  chapters=${targets.length}  dryRun=${flags.dryRun}\n`);

  const outDir = resolve(projectRoot, 'public/generated');
  await mkdir(outDir, { recursive: true });

  const manifest = { model: MODEL_ID, generatedAt: new Date().toISOString(), assets: {} };

  for (const ch of targets) {
    const prompt = buildPrompt(ch.visualPrompt);
    const input = buildInput(MODEL_ID, prompt, 'landscape');

    console.log(`─── ${ch.id} (${ch.roman}) ──────────────────────────────`);
    if (flags.dryRun) {
      console.log(prompt);
      console.log('input:', JSON.stringify(input, null, 2));
      continue;
    }

    try {
      const startedAt = Date.now();
      const resp = await fetch(`https://fal.run/${MODEL_ID}`, {
        method: 'POST',
        headers: {
          Authorization: `Key ${FAL_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }

      const data = await resp.json();
      const url = data?.images?.[0]?.url;
      if (!url) throw new Error(`No image URL in response. Raw: ${JSON.stringify(data).slice(0, 200)}`);

      // Download the binary so the site works offline / without fal CDN dependency.
      const ext = url.split('.').pop()?.split('?')[0]?.toLowerCase() ?? 'jpg';
      const safeExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg';
      const localPath = `public/generated/${ch.id}.${safeExt}`;
      const bin = await fetch(url).then((r) => r.arrayBuffer());
      await writeFile(resolve(projectRoot, localPath), Buffer.from(bin));

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ok ${seconds}s  →  /${localPath}`);
      manifest.assets[ch.id] = {
        url,
        local: `/generated/${ch.id}.${safeExt}`,
        seed: data?.seed,
        model: MODEL_ID,
      };
    } catch (err) {
      console.error(`  ERROR  ${err.message}`);
      manifest.assets[ch.id] = { error: String(err.message) };
    }
  }

  if (!flags.dryRun) {
    await writeFile(
      resolve(outDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
    console.log(`\n[generate-chapter-assets] manifest → public/generated/manifest.json\n`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
