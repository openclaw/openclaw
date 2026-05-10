---
name: telegram-crabbox-e2e-proof
description: Use when reviewing, reproducing, or proving OpenClaw Telegram behavior with a real Telegram user on Crabbox, including PR review workflows that need an agent-controlled Telegram Desktop recording, TDLib user-driver commands, Convex-leased credentials, WebVNC observation, and motion-trimmed artifacts.
---

# Telegram Crabbox E2E Proof

Use this for Telegram PR review or bug reproduction when bot-to-bot proof is
not enough. The goal is to let the agent keep a real Telegram user session open
until it is satisfied, then attach visual proof.

Do not use personal accounts. Do not add credentials to the repo, prompt, or
artifact bundle. The runner leases the shared burner account from Convex.

## Start

Run from the OpenClaw repo and branch under test:

```bash
pnpm qa:telegram-user:crabbox -- start \
  --tdlib-url http://artifacts.openclaw.ai/tdlib-v1.8.0-linux-x64.tgz \
  --output-dir .artifacts/qa-e2e/telegram-user-crabbox/pr-review
```

This starts one held session:

- leases the exclusive `telegram-user` Convex credential
- restores TDLib and Telegram Desktop with the same user account
- starts a mock OpenClaw Telegram SUT from the current checkout
- selects the configured Telegram chat in the visible Linux desktop
- starts desktop recording
- writes `.artifacts/qa-e2e/telegram-user-crabbox/pr-review/session.json`

Keep the session alive while investigating. It is valid for the agent to test
for minutes, run several commands, use WebVNC, inspect transcripts, and only
finish once the behavior is understood.

## While Testing

Send as the real Telegram user:

```bash
pnpm qa:telegram-user:crabbox -- send \
  --session .artifacts/qa-e2e/telegram-user-crabbox/pr-review/session.json \
  --text /status
```

For slash commands, omit the bot username; the runner targets the SUT bot.

Run arbitrary commands on the Crabbox:

```bash
pnpm qa:telegram-user:crabbox -- run \
  --session .artifacts/qa-e2e/telegram-user-crabbox/pr-review/session.json \
  -- bash -lc 'source /tmp/openclaw-telegram-user-crabbox/env.sh && python3 /tmp/openclaw-telegram-user-crabbox/user-driver.py transcript --limit 20 --json'
```

Useful remote user-driver commands:

```bash
source /tmp/openclaw-telegram-user-crabbox/env.sh
python3 /tmp/openclaw-telegram-user-crabbox/user-driver.py status --json
python3 /tmp/openclaw-telegram-user-crabbox/user-driver.py chats --json
python3 /tmp/openclaw-telegram-user-crabbox/user-driver.py transcript --limit 20 --json
python3 /tmp/openclaw-telegram-user-crabbox/user-driver.py send --text '/status@{sut}'
python3 /tmp/openclaw-telegram-user-crabbox/user-driver.py probe --text '@{sut} Reply exactly: USER-E2E-{run}' --expect USER-E2E-
```

Capture the current desktop without ending the session:

```bash
pnpm qa:telegram-user:crabbox -- screenshot \
  --session .artifacts/qa-e2e/telegram-user-crabbox/pr-review/session.json
```

Check lease state and get the WebVNC command:

```bash
pnpm qa:telegram-user:crabbox -- status \
  --session .artifacts/qa-e2e/telegram-user-crabbox/pr-review/session.json
```

## Finish

Always finish or explicitly keep the box:

```bash
pnpm qa:telegram-user:crabbox -- finish \
  --session .artifacts/qa-e2e/telegram-user-crabbox/pr-review/session.json
```

`finish` stops recording, creates motion-trimmed MP4/GIF artifacts, captures a
final screenshot and logs, releases the Convex credential, stops the local SUT,
and stops the Crabbox lease. Pass `--keep-box` only when a human needs to
continue VNC debugging after the credential is released.

After any failure or interruption, verify cleanup:

```bash
crabbox list --provider aws
```

If a session file exists and the credential may still be leased, run `finish`
with that session file before retrying.

## Attach Proof

Attach only the useful visual artifact to the PR unless logs are needed:

```bash
rm -rf .artifacts/qa-e2e/telegram-user-crabbox/pr-gif-only
mkdir -p .artifacts/qa-e2e/telegram-user-crabbox/pr-gif-only
cp .artifacts/qa-e2e/telegram-user-crabbox/pr-review/telegram-user-crabbox-session-motion.gif \
  .artifacts/qa-e2e/telegram-user-crabbox/pr-gif-only/telegram-user-crabbox-session-motion.gif
crabbox artifacts publish \
  --pr <pr-number> \
  --repo openclaw/openclaw \
  --dir .artifacts/qa-e2e/telegram-user-crabbox/pr-gif-only \
  --summary 'Telegram real-user Crabbox session motion GIF' \
  --template openclaw
```

Use full artifact publishing only when the PR needs logs or JSON output. Never
publish credential payloads, local env files, TDLib databases, Telegram Desktop
profiles, or raw session archives.

## Quick Smoke

For a fast one-shot check, use:

```bash
pnpm qa:telegram-user:crabbox -- --text /status
```

This is a start/send/finish shortcut. Prefer the held session for PR review,
issue reproduction, or any task where the agent may need several attempts.
