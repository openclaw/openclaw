---
name: discord-crabbox-e2e-proof
description: Use when reviewing, reproducing, or proving OpenClaw Discord behavior with real Discord Web on Crabbox, including PR review workflows that need an agent-controlled logged-in Discord viewer recording, Convex-leased bot credentials, WebVNC observation, and motion-trimmed artifacts.
---

# Discord Crabbox E2E Proof

Use this for Discord PR review or bug reproduction when REST proof or rendered HTML is not enough. The goal is to let the agent keep a logged-in Discord Web viewer session open until it is satisfied, then attach visual proof.

Do not use personal accounts. Do not add credentials to the repo, prompt, or artifact bundle. The runner leases shared Discord bot credentials from Convex and uses a dedicated logged-in browser profile as a viewer.

## Start

Run from the OpenClaw repo and branch under test:

```bash
pnpm qa:discord-web:crabbox -- start \
  --output-dir .artifacts/qa-e2e/discord-web-crabbox/pr-review
```

This starts one held session:

- leases the exclusive `discord` Convex credential
- starts a mock OpenClaw Discord SUT from the current checkout
- restores a logged-in Discord Web Chrome profile when `MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64` is set, or reuses `MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR`
- opens Discord Web to the leased guild/channel
- starts a 24fps desktop recording
- writes `.artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json`

Keep the session alive while investigating. It is valid for the agent to test for minutes, run several commands, use WebVNC, inspect transcripts, and only finish once the behavior is understood.

For deterministic visual repros, put the exact mock-model reply in a file and pass it to `start`:

```bash
pnpm qa:discord-web:crabbox -- start \
  --mock-response-file .artifacts/qa-e2e/discord-web-crabbox/reply.txt \
  --output-dir .artifacts/qa-e2e/discord-web-crabbox/pr-review
```

The runner defaults to `--class standard`, `--record-fps 24`, `--preview-fps 24`, and `--preview-width 1920`. Keep those defaults unless the proof needs something else.

## While Testing

Send as the driver Discord bot:

```bash
pnpm qa:discord-web:crabbox -- send \
  --session .artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json \
  --text 'Reply exactly: DISCORD-PROOF-123'
```

The command prints a Discord Web URL and message id. Open Discord Web directly to the newest relevant message before finishing:

```bash
pnpm qa:discord-web:crabbox -- view \
  --session .artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json \
  --message-id <message-id>
```

Run arbitrary commands on the Crabbox:

```bash
pnpm qa:discord-web:crabbox -- run \
  --session .artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json \
  -- bash -lc 'wmctrl -lxG'
```

Capture the current desktop without ending the session:

```bash
pnpm qa:discord-web:crabbox -- screenshot \
  --session .artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json
```

Check lease state and get the WebVNC command:

```bash
pnpm qa:discord-web:crabbox -- status \
  --session .artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json
```

## Finish

Always finish or explicitly keep the box:

```bash
pnpm qa:discord-web:crabbox -- finish \
  --session .artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json \
  --preview-crop discord-window
```

`finish` stops recording, creates motion-trimmed MP4/GIF artifacts, captures a final screenshot and logs, releases the Convex credential, stops the local SUT, and stops the Crabbox lease. `--preview-crop discord-window` also creates a fixed-geometry GIF from the tested Discord proof window for clean side-by-side PR tables; the full desktop video/GIF remains in the artifact directory. Pass `--keep-box` only when a human needs to continue VNC debugging after the credential is released.

After any failure or interruption, verify cleanup:

```bash
crabbox list --provider aws
```

If a session file exists and the credential may still be leased, run `finish` with that session file before retrying.

## Attach Proof

Attach only the useful visual artifact to the PR unless logs are needed. The runner is GIF-only by default:

```bash
pnpm qa:discord-web:crabbox -- publish \
  --session .artifacts/qa-e2e/discord-web-crabbox/pr-review/session.json \
  --pr <pr-number> \
  --summary 'Discord Web Crabbox session motion GIF'
```

Use `--full-artifacts` only when the PR needs logs or JSON output. Never publish credential payloads, browser cookies, browser profiles, VNC passwords, raw session archives, or local `.session` directories.

For before/after proof, run one session on `main` and one on the PR head, then build the Mantis evidence manifest with `scripts/mantis/build-discord-web-proof-evidence.mjs`.
