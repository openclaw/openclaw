# Music Creator V1

Music Creator V1 is a safe OpenClaw-powered music creation workbench. It turns
one music direction into a durable project manifest, provider prompt plan,
live-generation attempt log, candidate ingestion flow, QA gate, and publish
readiness gate.

The package does not store provider secrets and does not publish publicly.

## Flow

```bash
node music-creator-v1/scripts/music-creator-v1.mjs create \
  --request "Warm instrumental ambient piano cue for deep focus" \
  --artist "Validation Artist" \
  --duration 60 \
  --platform youtube

node music-creator-v1/scripts/music-creator-v1.mjs plan-generation --project <run-id>
node music-creator-v1/scripts/music-creator-v1.mjs provider-setup
node music-creator-v1/scripts/music-creator-v1.mjs generate-live --project <run-id> --candidate candidate-01
node music-creator-v1/scripts/music-creator-v1.mjs sync-live-output --project <run-id> --task <task-id-or-run-id> --candidate candidate-01
node music-creator-v1/scripts/music-creator-v1.mjs qa --project <run-id> --candidate candidate-01 --creative-total 90
node music-creator-v1/scripts/music-creator-v1.mjs select --project <run-id> --candidate candidate-01
node music-creator-v1/scripts/music-creator-v1.mjs publish-package --project <run-id>
```

## Mac Studio to MacBook GarageBand Bridge

The bridge lets OpenClaw on the Mac Studio and GarageBand on the MacBook work
together through a shared folder. By default it uses iCloud Drive when present:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-init
node music-creator-v1/scripts/music-creator-v1.mjs bridge-status
node music-creator-v1/scripts/music-creator-v1.mjs bridge-export --project <run-id> --candidate candidate-01
```

Preferred node enrollment is tokenless and short-lived. On the Mac Studio, run
`macstudio-open-node-enrollment.command`; while that window is open, run
`macbook-pair-openclaw-node-window.command` on the MacBook to install/start the
OpenClaw node host and create a pending node request without pasting the Gateway
token. The Mac Studio helper restores the previous Gateway auth mode when it
exits.

Remote Login is no longer the default bridge path. For safer automation, run
`macbook-pull-agent.command` on the MacBook instead. The MacBook polls
`to-macbook/requests/`, verifies every request with
`macstudio-bridge-signing.pub.pem`, rejects expired/unsigned jobs, and accepts
only whitelisted actions. OpenClaw does not get an SSH shell, arbitrary command
execution, or free-form filesystem access on the MacBook.

If you previously tested the Remote Login helper, run
`macbook-disable-remote-exec.command` on the MacBook and keep Remote Login off in
System Settings > General > Sharing.

Before relying on automation, prove the shared folder syncs both directions:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-sync-probe
```

After the probe appears on the MacBook, run
`00-RUN-ME-MACBOOK-SAFE-BRIDGE.command` from the bridge folder on the MacBook. It
blocks if Remote Login is on, writes the sync reply, and processes one signed
pull-agent request. Then verify on the Mac Studio:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-sync-status
```

If the MacBook and Mac Studio do not have one editable two-way shared folder
(for example, different Apple IDs with read-only iCloud access), make a portable
safe transfer kit instead:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-transfer-kit
```

Send the generated `OpenClaw-GarageBand-Bridge` kit folder to the MacBook, run
`00-RUN-ME-MACBOOK-SAFE-BRIDGE.command`, then send the returned folder back to
the Mac Studio and import only the safe result subfolders:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-import-transfer-return --return-root <returned-folder>
node music-creator-v1/scripts/music-creator-v1.mjs bridge-sync-status
node music-creator-v1/scripts/music-creator-v1.mjs bridge-status
```

This fallback still does not use SSH or Remote Login. The import command copies
only `from-macbook/`, `sync/macbook/`, and `logs/`; it does not execute returned
files or import MacBook-supplied requests.

Queue signed MacBook-side jobs from the Mac Studio:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-queue-job --action health-check
node music-creator-v1/scripts/music-creator-v1.mjs bridge-queue-job --action garageband-status
node music-creator-v1/scripts/music-creator-v1.mjs bridge-queue-job --action open-latest-bridge-job
node music-creator-v1/scripts/music-creator-v1.mjs bridge-queue-job --action open-bridge-job --job <bridge-job-id>
```

Fallback enrollment: on the MacBook, run `macbook-pair-openclaw-node.command`.
The helper targets the Mac Studio Gateway over Tailscale, asks for the Gateway
token locally on the MacBook, and writes `from-macbook/macbook-node-status.json`
without writing the token into iCloud. Back on the Mac Studio, approve the
pending node request with `openclaw nodes approve <request-id>`.

Then run
`macbook-finish-setup.command` first. It opens the GarageBand App Store page if
needed, downloads and opens the official Valhalla Supermassive installer,
validates the AU plugin with `auval`, opens GarageBand, and writes
`from-macbook/macbook-prereq-status.json` back through iCloud.

Then run
`macbook-open-latest.command`. The helper opens GarageBand, reveals the exported
audio file, and writes status back under `from-macbook/`. After arranging or
processing in GarageBand, bounce/export the result as WAV, AIFF, MP3, or M4A
into `from-macbook/<job-id>/`.

Back on the Mac Studio, ingest the returned GarageBand bounce:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-ingest --project <run-id> --job <job-id>
```

To start from GarageBand instead, run `macbook-send-audio-to-openclaw.command`
from the synced bridge folder on the MacBook. It lets you choose a song, stem,
reference, or vocal bounce and writes an inbox packet for OpenClaw. Back on the
Mac Studio:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-import-garageband --project <run-id>
node music-creator-v1/scripts/music-creator-v1.mjs vocal-plan --project <run-id> --source <source-id> --lyrics-file lyrics.txt --vocal-direction "Intimate lead vocal with airy harmonies"
node music-creator-v1/scripts/music-creator-v1.mjs vocal-generate-live --project <run-id> --plan <vocal-plan-id>
node music-creator-v1/scripts/music-creator-v1.mjs vocal-ingest --project <run-id> --plan <vocal-plan-id> --file <cloud-or-openclaw-vocal-audio>
node music-creator-v1/scripts/music-creator-v1.mjs bridge-export --project <run-id> --vocal <vocal-id>
```

`vocal-generate-live` uses OpenClaw `music_generate` when provider credentials
exist. If a cloud vocal tool is used outside OpenClaw, save the resulting vocal
audio locally and import it with `vocal-ingest`; Music Creator V1 records the
source label, plan id, and hash before sending it back to GarageBand.

Exact artist or real-person voice cloning is blocked by default. Use an
original vocal identity, a licensed synthetic singer, or an explicitly
authorized voice model with rights evidence instead.

GarageBand install, AU plugin authorization, drag/import, and final bounce are
local MacBook actions. `macbook-finish-setup.command` automates discovery,
downloads, app opening, and validation, but the Mac App Store and system plugin
installer can still require local Apple ID/admin approval.

If no supported provider key is present, `generate-live` records
`blocked_missing_credentials` instead of pretending generation succeeded.
If OpenClaw starts an async background task, `sync-live-output` reads
`openclaw tasks show <task-id-or-run-id> --json`, finds returned local `MEDIA:`
audio paths, copies the audio into `candidates/`, hashes it, and updates the
project manifest/catalog.

Supported provider env vars:

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` for Google Lyria.
- `MINIMAX_API_KEY` for MiniMax Music.
- `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` for ComfyUI music workflows.
- `KITS_API_KEY` for Kits AI royalty-free voice conversion.

## Kits AI Royalty-Free Voices

Kits AI is connected as an optional vocal provider. It uses the official Kits
API for voice model listing and voice-conversion jobs:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs kits-list-voices --per-page 20

node music-creator-v1/scripts/music-creator-v1.mjs kits-convert \
  --project <run-id> \
  --plan <vocal-plan-id> \
  --file <your-guide-vocal.wav> \
  --voice <kits-voice-model-id>

node music-creator-v1/scripts/music-creator-v1.mjs kits-sync \
  --project <run-id> \
  --job <kits-job-id> \
  --vocal <vocal-id>

node music-creator-v1/scripts/music-creator-v1.mjs bridge-export --project <run-id> --vocal <vocal-id>
```

Create the token in Kits AI, then export it privately before running live Kits
commands:

```bash
export KITS_API_KEY="..."
```

Kits command logs record job ids, voice model ids, file hashes, and status. They
do not write the API token. Exact artist or real-person voice cloning remains
blocked; use Kits royalty-free/consensually licensed voices or your own
authorized custom voice only.

`provider-setup` writes:

- `music-creator-v1/state/provider-readiness.json`
- `music-creator-v1/automation/provider-env.template`

The template contains blank values only. Put real keys in a private file outside
git and source that file before live generation.

Release readiness is explicit. Use `set-release-gate` only after the matching
human or platform review is complete:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs set-release-gate --project <run-id> --gate humanFinalAudioApproval
node music-creator-v1/scripts/music-creator-v1.mjs set-release-gate --project <run-id> --gate rightsOwnerConfirmed
node music-creator-v1/scripts/music-creator-v1.mjs set-release-gate --project <run-id> --gate aiDisclosureReviewed
node music-creator-v1/scripts/music-creator-v1.mjs set-release-gate --project <run-id> --gate modelToolRightsEvidenceRecorded
node music-creator-v1/scripts/music-creator-v1.mjs set-release-gate --project <run-id> --gate platformMetadataComplete
node music-creator-v1/scripts/music-creator-v1.mjs set-release-gate --project <run-id> --gate publicPublishingApproval
```

## Validation

```bash
node --check music-creator-v1/scripts/music-creator-v1.mjs
node music-creator-v1/scripts/music-creator-v1.mjs provider-setup
node music-creator-v1/scripts/music-creator-v1.mjs validate --rebuild-catalog
node music-creator-v1/scripts/music-creator-v1.mjs health
node music-creator-v1/scripts/music-creator-v1.mjs doctor
node music-creator-v1/scripts/music-creator-v1.mjs bridge-init
node music-creator-v1/scripts/music-creator-v1.mjs bridge-sync-probe
node music-creator-v1/scripts/music-creator-v1.mjs bridge-sync-status
node music-creator-v1/scripts/music-creator-v1.mjs bridge-queue-job --action health-check
node music-creator-v1/scripts/music-creator-v1.mjs bridge-transfer-kit --bridge-root music-creator-v1/tmp-safe-bridge --kit validation-transfer-kit
node music-creator-v1/scripts/music-creator-v1.mjs bridge-import-transfer-return --bridge-root music-creator-v1/tmp-safe-bridge --return-root music-creator-v1/state/bridge-transfer-kits/validation-transfer-kit/OpenClaw-GarageBand-Bridge
node music-creator-v1/scripts/music-creator-v1.mjs bridge-status
node music-creator-v1/scripts/music-creator-v1.mjs vocal-generate-live --project <run-id> --plan <vocal-plan-id> --dry-run
pnpm exec oxfmt --check --threads=1 music-creator-v1
git diff --check -- music-creator-v1
```
