---
name: higgsfield-soul-id
description: |
  Train a Soul Character, a personalized model on a person's face that
  Higgsfield uses for identity-faithful image and video generation.
  Use when: "create my Soul", "train my face", "make my digital twin",
  "build me an avatar", "learn my appearance", "create a character of me",
  "set up identity for video", "I want my face in generated images".
  Chain: train Soul once, get reference_id, then use in
  higgsfield-generate via --soul-id with models like
  `text2image_soul_v2` or `soul_cinema_studio`.
  NOT for: one-shot face swaps (use higgsfield-generate with --image),
  named-character / non-photo avatars (use higgsfield-generate with prompt).
allowed-tools: Bash
---

# Higgsfield Soul Character

Train a face-faithful identity model. Reusable across all Soul-powered generations.

## Step 0 — Bootstrap

Before any other command:

1. If `higgsfield` is not on `$PATH`, install it:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh
   ```
2. If `higgsfield account status` fails with `Session expired` / `Not authenticated`, ask the user to run `higgsfield auth login` (interactive) and wait for confirmation.
3. Soul training requires a paid plan (Basic+). If `higgsfield account status` shows free plan, tell the user before submitting.

## UX Rules

1. Be concise. No raw IDs in chat. Just say "Soul ready" with a name reference.
2. Detect language and respond in it. CLI flags stay English.
3. Ask for the smallest set of inputs: name + photos. Pick a sensible model variant.
4. Polling is silent — training takes minutes. Don't repeat status updates.

## Workflow

1. **Get name.** One word, used for later reference. Ask if missing.
2. **Get photos.** 5–20 face photos, varied angles and lighting. Local paths or already-uploaded IDs both work — `--image` accepts either.
3. **Pick variant.**
   - `--soul-2` — for image generation (default)
   - `--soul-cinematic` — for cinematic / video work
   Choose based on user's stated downstream use. Default to `--soul-2`.
4. **Submit.**
   ```bash
   higgsfield soul-id create --name "<name>" --soul-2 --image ./photo1.png --image ./photo2.png ...
   higgsfield soul-id create --name "<name>" --soul-2 --image <upload_id> --image <upload_id> ...
   ```
   CLI auto-uploads paths. Captures returned reference id.
5. **Wait.** `higgsfield soul-id wait <id>`. Silent. Default timeout 30m.
6. **Deliver.** "Soul `<name>` ready. Use in generate with `--soul-id <id>`."

## Use the Soul

Once trained, pass to `higgsfield-generate`:

```bash
higgsfield generate create text2image_soul_v2 --prompt "..." --soul-id <ref_id> --wait
higgsfield generate create soul_cinema_studio --prompt "..." --soul-id <ref_id> --wait
```

## Listing existing Souls

```bash
higgsfield soul-id list                   # all references
higgsfield soul-id get <id>               # one by id
```

## Errors

- `Minimum Basic plan required` — user is on free plan; tell them.
- `Training failed` — check photos quality (5+ unique faces, well-lit).
- `Session expired` → `higgsfield auth login`.

## Reference docs

- `references/photo-guide.md` — what photos work best
- `references/troubleshooting.md` — common training failures
