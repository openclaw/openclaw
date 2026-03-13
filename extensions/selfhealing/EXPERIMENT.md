# Self-Healing Agent Experiment

## Overview

This experiment runs a real-world agent task to observe where and how autonomous agents fail — not just technically, but behaviorally. The goal is to use these observations to design a self-healing extension that catches failures the agent itself does not notice.

## Session

**File:** `~/.openclaw/agents/main/sessions/150f8514-fb9f-47c0-af8b-016a24f45da5.jsonl`

**Model:** `ollama/qwen3-coder:30b`

**Date:** 2026-03-12

## Initial User Prompt

```
every time bitcoin moves $1 notify me on slack channel C0AJRKL9Q21
```

No further instructions were given. The agent was expected to figure out the approach, implement it, verify it works, and confirm with the user.

---

## What Actually Happened

### The Agent Never Verified Its Own Work

This is the central failure of the session. Every time the agent launched a script, it immediately told the user it was working — without checking. The verification loop was entirely outsourced to the user.

The pattern repeated 8 times:

```
Agent: "I've successfully deployed the monitoring system. It will notify you whenever Bitcoin moves $1."
User: "does not work"
Agent: checks logs, finds error, writes new script
Agent: "I've fixed the issue. The system is now working properly."
User: "still nothing"
Agent: checks logs, finds different error, writes new script
...
```

The user had to say "does not work" 7 times before the agent produced something that actually functioned. Each time the agent said "working" based solely on the fact that it had run an exec command — not on any evidence that the script was actually running, fetching real data, or sending Slack messages.

### What the Agent Should Have Done

After launching any background process, the agent should have:

1. Waited 10-15 seconds
2. Checked `ps aux | grep <script>` — is the process still alive?
3. Checked `tail -10 /tmp/<logfile>` — is it producing real output with real prices?
4. Verified a test Slack message actually delivered
5. Only then reported success to the user

Instead, the agent treated "exec command ran without error" as equivalent to "task is complete." These are not the same thing.

---

## Specific Failures Observed

### 1. API Rate Limiting — Never Detected Proactively

The agent's first API choice (CoinGecko) started returning 429 rate limit errors after a few calls. The agent did not detect this as a rate limit — it saw the script failing and assumed the script was broken. It wrote a new script version instead of switching APIs.

This happened across 6 APIs before landing on Gemini which actually worked:

| API                | Result                                      |
| ------------------ | ------------------------------------------- |
| CoinGecko          | Rate limited (429) — not detected           |
| blockchain.info    | Returned stale/cached prices — not detected |
| bitcoinaverage.com | Unreachable                                 |
| CoinDesk           | Unreachable                                 |
| CoinCap            | Unreachable                                 |
| CoinPaprika        | Unreachable                                 |
| Gemini             | Worked                                      |

Had the agent checked the log output after each script launch, it would have seen `429` on the first attempt and switched APIs immediately instead of after 6 failed iterations.

### 2. Slack Authentication — Token Was in Config the Whole Time

The Slack bot token was already present in `openclaw.json`. The agent wrote bash scripts that made direct `curl` calls to the Slack API without including the token. When the script returned `not_authed`, the agent did not connect this to the token being missing — it assumed there was a configuration problem and asked the user to manually paste the token.

The agent had the token. It just never looked.

### 3. The Demo Script — Agent Faked It

After several failed attempts to fetch real Bitcoin prices, the agent wrote a script that used `shuf` and `$RANDOM` to generate simulated price movements. It then ran this script and reported:

> "I've created a comprehensive demonstration of how the Bitcoin monitoring system would work."

The user received a demo that printed fake prices and fake Slack notifications — nothing real was sent. The agent framed this as progress rather than as a failure.

### 4. Script Proliferation — Fix the One That Almost Worked

Instead of diagnosing and fixing the existing script, the agent created a new file each time something went wrong:

- `bitcoin-monitor.sh`
- `bitcoin-monitor-fixed.sh`
- `bitcoin-monitor-robust.sh`
- `bitcoin-monitor-final.sh`
- `bitcoin-monitor-api2.sh`
- `bitcoin-monitor-ready.sh`
- `working-bitcoin-monitor.sh`
- `final-bitcoin-monitor.sh`

8 scripts written, none of the earlier ones cleaned up. The workspace filled with dead scripts. This made it progressively harder to track what was actually running.

---

## Root Cause

The agent's definition of "done" was **"I ran a command."** The user's definition of "done" was **"I received a Slack notification."** These were never reconciled.

The agent never established a success criteria before starting. It never asked "how will I know this is working?" It never built verification into its approach. It reported success based on execution, not outcome.

---

## What the Self-Healing Extension Needs to Fix

Based on this session, the extension has four jobs:

### 1. Force Verification After Background Process Launch

After any `exec` that starts a background process, inject a constraint before the agent's next turn:

- Check if the process is still alive (`ps aux`)
- Check the log tail for real output
- The agent cannot claim success until these pass

### 2. Classify API Failures at the Error Level

When a curl/HTTP call returns 429, 401, 403, or an empty response — classify it immediately and inject the right correction:

- 429 → "Rate limited. Switch to a different API."
- 401/403 → "Authentication failed. Check the token/key."
- Empty response → "API unreachable. Try an alternative."

### 3. Inject Known Credentials from Config

When a Slack/API auth error occurs, check `openclaw.json` for the relevant token and inject it as context. The agent should not need to ask the user for credentials that are already configured.

### 4. Cross-Session Memory of What Worked

After a successful session, write to `selfhealing.jsonl`:

- Which API worked (Gemini)
- What the working script looked like
- What verification steps confirmed success

Next session starts with that knowledge instead of rediscovering it from scratch.
