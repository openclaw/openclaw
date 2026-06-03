# Getting started — fal.ai image generation (beginner guide)

The full-release-site mode of this skill generates chapter hero images through **fal.ai**. You bring your own API key. The skill does **not** ship with keys, credits, or a shared account — and you can skip fal.ai entirely (the page renders stunning CSS-only chapter visuals at $0).

---

## Quick answers

| Question | Answer |
|---|---|
| Do I get a fal.ai key with the skill? | **No.** You create a free fal.ai account and add your own key. |
| Who pays for image generation? | **You**, directly to fal.ai (pay-as-you-go credits). |
| Is my key exposed in the browser? | **No.** Keys stay server-side via a Next.js proxy route. |
| Can I skip fal.ai and use my own images? | **Yes.** Replace manifest asset URLs with your own files in `public/`. |

---

## What you need before you start

1. **Node.js 18+** and **npm**
2. A **Next.js App Router** project (or let the skill scaffold one for you)
3. A **fal.ai account** — sign up at [https://fal.ai](https://fal.ai)
4. About **5 minutes** for first-time key setup

Estimated cost for a typical 8-chapter release page: **~$0.50–$2.00** in fal.ai credits (model-dependent). Check current pricing on fal.ai before generating large batches.

---

## Step 1 — Create a fal.ai account and API key

1. Go to [https://fal.ai](https://fal.ai) and sign up (email or GitHub).
2. Open **Dashboard → API Keys** (or **Settings → Keys**).
3. Click **Create API Key**.
4. Copy the key immediately — it looks like:

   ```
   abc123def456:9876543210abcdef9876543210abcdef
   ```

   Format is always `key_id:key_secret` (two parts separated by a colon).

5. Add billing/credits if fal.ai prompts you. Most accounts need a small credit balance before generation works.

> **Security:** Treat this key like a password. Never commit it to Git, never paste it into client-side React components, and never share it in screenshots.

---

## Step 2 — Add the key to your project

In your Next.js project root (same folder as `package.json`):

1. Copy the example env file:

   ```bash
   cp .env.example .env.local
   ```

2. Open `.env.local` and set your key:

   ```bash
   FAL_KEY="your_key_id:your_key_secret"
   FAL_IMAGE_MODEL="fal-ai/flux-2-pro"
   NEXT_PUBLIC_SITE_NAME="My Release Page"
   ```

3. Confirm `.env.local` is in `.gitignore` (Next.js adds this by default).

### Environment variables explained

| Variable | Required? | What it does |
|---|---|---|
| `FAL_KEY` | **Yes** | Your fal.ai API key. Read only on the **server** (API routes). |
| `FAL_IMAGE_MODEL` | No | Image model id. Default: `fal-ai/flux-2-pro` (see tier table below). |
| `FAL_VIDEO_MODEL` | No | Optional video model for motion loops. Leave empty until you need video. |
| `NEXT_PUBLIC_SITE_NAME` | No | Site title shown in the browser tab. Safe to expose (no secret). |

### Image model tiers

Change `FAL_IMAGE_MODEL` to switch — no code change needed.

**FLUX family — best photorealism, material texture, editorial depth**

| Model ID | Cost/img | Speed | When to use |
|---|---|---|---|
| `fal-ai/flux-2-pro` | ~$0.06 | ~4s | **Default — SOTA editorial, portraits, materials** |
| `fal-ai/flux-2-max` | ~$0.08 | ~5s | Final hero renders, absolute max quality |
| `fal-ai/flux-2/turbo` | ~$0.02 | ~2s | Draft rounds, fast iteration |
| `fal-ai/flux-pro/v1.1/ultra` | ~$0.06 | ~10s | Prev-gen 4MP alternative |
| `fal-ai/flux-pro/v1.1` | ~$0.05 | ~4.5s | High-volume cost-sensitive batches |
| `fal-ai/flux/dev` | Free | Slow | **NON-COMMERCIAL ONLY — local prototyping, never production** |

**Google "Nano Banana" family — best for text-in-image, conversational editing, complex scene direction**

(Yes, "Nano Banana" is the real Google/fal.ai nickname — not a joke.)

| Model ID | Nickname | Cost/img | Speed | When to use |
|---|---|---|---|---|
| `fal-ai/gemini-3-pro-image-preview` | Nano Banana Pro | ~$0.15 | ~8s | Complex prompts, typography, web-search grounding |
| `fal-ai/gemini-3.1-flash-image-preview` | Nano Banana 2 | ~$0.07 | ~2s | Newest Flash — fast + accurate text in image |
| `fal-ai/gemini-2.5-flash-image` | Nano Banana | ~$0.04 | ~2s | Cheapest Google option |
| `fal-ai/imagen3` | Imagen 3 | ~$0.04 | ~3s | Strong photorealism at low cost |

**When to use Nano Banana instead of FLUX:**
- Your chapter heroes need legible text baked into the image (labels, signs, editorial title cards)
- You're doing iterative editing ("darken the background, add fog")
- You need web-search-grounded imagery (real-world references)

**FLUX.2 Pro wins for:** editorial depth, skin/fabric/material texture, atmospheric still-life — the core use case of this skill.

**Typical 8-chapter release page cost:**
- FLUX.2 Pro default: 8 × $0.06 = **~$0.48**
- Nano Banana 2 alternative: 8 × $0.07 = **~$0.56**
- Mixed (6 FLUX + 2 Nano Banana for text-heavy chapters): **~$0.50**

---

## Step 3 — Install dependencies

From your project root, run **one command at a time** (do not paste multi-line blocks with `#` comments — zsh will error):

```bash
npm install
```

If install fails with `No matching version found for @studio-freight/lenis`:

- The project has the **wrong Lenis package**. Replace dependencies with the bundled `templates/nextjs/package.json`.
- Use `lenis` (^1.3.23), **not** `@studio-freight/lenis`.

Required packages (from bundled template):

```bash
npm install choreo-3d framer-motion gsap lenis @fal-ai/client @fal-ai/server-proxy next react react-dom
```

If the skill copied templates from `templates/nextjs/`, use the bundled `package.json` instead of merging manually.

---

## Step 4 — How the key is used (safe pattern)

The bundled templates use a **server-side proxy**. Your browser never sees `FAL_KEY`.

```
Browser  →  /api/fal/proxy  →  fal.ai API
                ↑
         FAL_KEY injected here (server only)
```

| File | Role |
|---|---|
| `app/api/fal/proxy/route.ts` | Proxies browser fal requests; key stays on server |
| `app/api/generate-edition-asset/route.ts` | Server route for chapter image generation |
| `lib/fal-client.ts` | Client config — sets `proxyUrl: '/api/fal/proxy'` only |
| `lib/fal-generate.ts` | Builds prompts and calls fal on the server |
| `lib/prompt-contract.ts` | Structured prompt schema per chapter |

**Rule:** If you see `FAL_KEY` or `process.env.FAL_KEY` inside a `'use client'` component, that is a bug — move the call to an API route.

---

## Step 5 — Run locally and test one image

1. Start the dev server:

   ```bash
   npm run dev
   ```

2. Test the generation route (replace values with your chapter):

   ```bash
   curl -X POST http://localhost:3000/api/generate-edition-asset \
     -H "Content-Type: application/json" \
     -d '{
       "chapterId": "prologue",
       "subject": "classical marble bust beside a glowing laptop",
       "productTruth": "AI release notes as editorial artifact",
       "historicalLayer": "renaissance",
       "modernLayer": "glass UI panel, monospace code overlay",
       "palette": ["#0a0a0a", "#f5f0e8", "#c9a227"],
       "camera": "medium",
       "outputRole": "hero"
     }'
   ```

3. A successful response includes an image `url` you can open in the browser.

4. If you get `{ "error": "Missing FAL_KEY" }`, your `.env.local` is missing, misnamed, or the dev server was started before you added the key — **restart `npm run dev`**.

---

## Step 6 — Generate assets for all chapters

Use the bundled batch script — it reads `lib/editions-manifest.ts`, calls fal once per chapter, and writes both the URL and the binary to `public/generated/`.

```bash
# Dry run: print prompts only, no fal calls, no credit cost
node scripts/generate-chapter-assets.mjs --dry-run

# Generate all chapters with the default model (FLUX.2 Pro)
node scripts/generate-chapter-assets.mjs

# Only regenerate two chapters
node scripts/generate-chapter-assets.mjs --only prologue,studio

# Use a different model just for this run
node scripts/generate-chapter-assets.mjs --model fal-ai/gemini-3-pro-image-preview
```

Output:

```
public/generated/
  prologue.jpg
  agentic.jpg
  studio.jpg
  …
  manifest.json    ← {chapterId → {url, local, seed, model}}
```

Set `manifest.assets[id].local` paths on your chapter `background` fields in `editions-manifest.ts` for production — Next/Image will serve them from the static folder.

### Queue mode (batches > 5 images, video, slow models)

```bash
curl -X POST http://localhost:3000/api/generate-edition-asset \
  -H "Content-Type: application/json" \
  -d '{"mode":"queue","chapterId":"prologue", ... }'
# → { "status":"queued", "requestId":"...", "modelId":"fal-ai/flux-2-pro" }
```

The result is POSTed to `/api/fal/webhook?chapter=prologue` when fal finishes. Wire that route to your DB / KV to persist the URL — see `app/api/fal/webhook/route.ts`.

---

## Deploying to Vercel (production)

1. Push code **without** `.env.local` (never commit secrets).
2. In Vercel: **Project → Settings → Environment Variables**.
3. Add `FAL_KEY` with your key value (Production + Preview).
4. Optionally add `FAL_IMAGE_MODEL` and `NEXT_PUBLIC_SITE_NAME`.
5. Redeploy.

The same server proxy pattern works on Vercel — no code changes needed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing FAL_KEY` | Env file not loaded | Create `.env.local`, set `FAL_KEY`, restart dev server |
| `401` / `403` from fal | Invalid or expired key | Regenerate key in fal.ai dashboard |
| `402` / insufficient credits | No fal.ai balance | Add credits in fal.ai billing |
| Images generate but page is blank | Unrelated to fal — scroll/sandbox issue | Apply the Mode A sandbox fallback rules in `SKILL.md` (§ MODE A) |
| Key visible in browser DevTools | Key used in client code | Move generation to `/api/generate-edition-asset` only |

---

## Working without fal.ai (static images)

You do not need fal.ai to use the scroll page:

1. Add your own images to `public/assets/…`
2. Set chapter `asset.src` in `editions-manifest.ts` to those paths
3. Skip `/api/generate-edition-asset` entirely

The motion system (`choreo-3d`, parallax, pinning) works the same with static assets.

---

## Need help?

When using this skill in Claude or Cursor, try:

> I'm new to fal.ai. Walk me through creating an API key, setting `.env.local`, and generating one test hero image for my release page. Use the bundled templates — do not expose FAL_KEY in client code.

See also `examples/PROMPTS.md` for full build prompts once setup is complete.
