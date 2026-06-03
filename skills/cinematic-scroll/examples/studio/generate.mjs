#!/usr/bin/env node
/* ============================================================================
   generate.mjs — generate the 6 monochrome stills for the studio example.

   RUN THIS ON A MACHINE WITH NETWORK ACCESS TO fal.ai (e.g. Claude Code on
   your Mac). The Cowork sandbox cannot reach fal.ai, which is why this is a
   standalone script.

   Model: Nano Banana Pro  (fal-ai/gemini-3-pro-image-preview)  ~$0.15/img.
   To use the cheaper/faster Nano Banana 2 instead, set:
       MODEL=fal-ai/gemini-3.1-flash-image-preview  node generate.mjs

   Setup (once):
       1. Put your key in examples/studio/.env.local  (or repo-root .env.local):
              FAL_KEY=xxxxxxxx:xxxxxxxx
          (.env.local is already gitignored — never commit your key.)
       2. node examples/studio/generate.mjs            # generate all 6
          node examples/studio/generate.mjs --only 2-work   # one chapter
          node examples/studio/generate.mjs --dry-run       # print prompts only

   Output: examples/studio/assets/<id>.jpg  (16:9, top-cropped, ~web-sized)
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAPTERS } from './chapters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, 'assets');
const MODEL = process.env.MODEL || 'fal-ai/gemini-3-pro-image-preview'; // Nano Banana Pro
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// hard negative guard appended to every prompt — keeps it brand/text-safe
const GUARD = ' STRICT: no text, no typography, no letters, no words, no logos, ' +
  'no watermarks, no brand marks, no recognisable real product. Pure monochrome ' +
  'black and white only, no colour. Editorial, high contrast, fine film grain.';

// ---- load FAL_KEY from env or a .env.local (this dir, then repo root) ----
function loadKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  for (const p of [join(__dirname, '.env.local'), join(__dirname, '../../.env.local')]) {
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/^\s*FAL_KEY\s*=\s*["']?([^"'\n\r#]+)/m);
      if (m) return m[1].trim();
    }
  }
  console.error('✗ No FAL_KEY found. Set it in examples/studio/.env.local or the environment.');
  process.exit(1);
}

async function generateOne(ch, key) {
  const prompt = ch.prompt + GUARD;
  if (DRY) { console.log(`\n[${ch.id}]\n${prompt}\n`); return; }

  process.stdout.write(`[${ch.id}] generating … `);
  // submit (sync endpoint — waits for the result)
  const res = await fetch(`https://fal.run/${MODEL}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      num_images: 1,
      aspect_ratio: '16:9',           // Nano Banana uses aspect_ratio (not image_size)
      resolution: '2K',
      output_format: 'jpeg',
      safety_tolerance: '4',
    }),
  });
  if (!res.ok) {
    console.log(`✗ HTTP ${res.status}`);
    console.log('  ', (await res.text()).slice(0, 300));
    return;
  }
  const data = await res.json();
  const url = data?.images?.[0]?.url;
  if (!url) { console.log('✗ no image url in response'); console.log(JSON.stringify(data).slice(0,300)); return; }

  // download
  const imgRes = await fetch(url);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const out = join(ASSETS, `${ch.id}.jpg`);
  writeFileSync(out, buf);
  console.log(`✓ ${(buf.length/1024|0)} KB → assets/${ch.id}.jpg`);
  console.log(`   ↳ if any baked-in text/logo slipped through, re-run: node generate.mjs --only ${ch.id}`);
}

async function main() {
  if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
  const key = DRY ? 'dry' : loadKey();
  const list = ONLY ? CHAPTERS.filter(c => c.id === ONLY) : CHAPTERS;
  if (!list.length) { console.error(`No chapter "${ONLY}". Ids: ${CHAPTERS.map(c=>c.id).join(', ')}`); process.exit(1); }
  console.log(`Model: ${MODEL}${DRY ? '  (dry-run)' : ''}  ·  ${list.length} image(s)\n`);
  for (const ch of list) await generateOne(ch, key);
  if (!DRY) {
    console.log('\nDone. Next: open index.html (or run a local server) to see them in motion.');
    console.log('Tip: review each still — they must be pure B&W with NO baked text/logos.');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
