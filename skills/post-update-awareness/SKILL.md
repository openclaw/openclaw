---
name: post-update-awareness
description: "After an OpenClaw version change, read the CHANGELOG entry for the new version and surface the user-relevant changes — new tools, breaking changes, and optional native dependencies that may need verification (sharp, ffmpeg, etc.). Runs once per detected version bump. Use when the gateway has just been updated or the agent notices its known version has changed since last run."
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["node"] }
      }
  }
---

# Post-Update Awareness

When OpenClaw is updated, the agent should not be the last to know. This skill reads the project CHANGELOG for the new version, distills what changed for the user, and surfaces it once.

## When to use

Run this skill when **any** of the following is true:

1. The gateway log reports a successful version change (e.g. `openclaw -V` differs from the value the agent has on file).
2. A first-class update flow finishes (`openclaw update`, `openclaw plugins update`, package-manager update).
3. The user mentions an update they just performed and asks "what changed?" — even without a heartbeat trigger.
4. Heartbeat / `update-guard` script reports `GUARD_RECOVERED` or `GUARD_OK` after a version bump.

Do **not** run on every heartbeat. Run **once per detected version change** and persist the new version so subsequent heartbeats stay quiet.

## Scope and non-goals

This skill **only**:

- Reads existing CHANGELOG content
- Reports it to the user
- Optionally probes for known-flaky optional native deps mentioned in the entry

This skill **does not**:

- Apply updates (`openclaw update` already handles that)
- Modify configuration (config drift is a separate concern; surface only)
- Install missing dependencies without explicit user confirmation
- Roll back versions (per the existing "no auto-rollback" convention; surface and let the user decide)

## Workflow (follow in order)

### 1) Detect a version change

Compare the current installed version against the agent's last-known version.

- Current: `openclaw -V` (output like `OpenClaw 2026.5.3-1 (2eae30e)`)
- Last-known: a small JSON file the skill maintains, e.g. `~/.openclaw/state/post-update-awareness.json` with `{ "lastKnownVersion": "2026.5.2", "lastSurfacedAt": "2026-05-04T13:15:00Z" }`

If the file does not exist, treat the current version as the initial baseline, write it, and exit silently. (No CHANGELOG dump on first run — only on actual transitions.)

If `currentVersion === lastKnownVersion`, exit silently.

If `currentVersion !== lastKnownVersion`, continue.

### 2) Fetch the CHANGELOG entry

Try, in order:

1. **Local** — read the bundled CHANGELOG if available at the install root (e.g. `/opt/homebrew/lib/node_modules/openclaw/CHANGELOG.md` on macOS Homebrew, or platform-equivalent).
2. **Remote** — `curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG.md` if the local copy is missing or older than the installed version.

Extract only the section for the new version (between `## <newVersion>` and the next `## ` heading). Do not dump the whole file.

If neither source is available, surface a short note ("OpenClaw was updated to vX, but I couldn't read the CHANGELOG to summarize what changed.") and exit. Do not invent.

### 3) Distill the entry into 3 buckets

Read the version's CHANGELOG section and group items into:

- **🆕 New for you** — new tools, new commands, new channels, new capabilities the agent could benefit from. Filter ruthlessly to what an end-user agent actually touches; skip internal refactor lines, build-system changes, and CI plumbing.
- **⚠️ Breaking or removed** — anything that could change current behavior: removed config keys, renamed CLI commands, deprecated features, security tightenings that may block previously-accepted input.
- **🔧 May need attention** — optional native dependencies mentioned (`sharp`, `ffmpeg`, `libvips`, etc.), peer-dep notes, post-install scripts, and config-format migrations.

Keep each bucket tight: 1–4 bullets max. If a bucket has nothing relevant, omit it entirely.

### 4) Probe known-flaky optional deps (best effort)

If the CHANGELOG's "May need attention" bucket mentions a known-flaky native module, do a non-blocking probe:

```bash
node -e "require('<dep>'); process.exit(0)" 2>/dev/null
```

Report missing deps in the surfaced summary as `❌ sharp (image processing) — not installed` so the user knows to fix. Do not auto-install.

Known list (extend as the project evolves):

- `sharp` — image attachment optimization
- `ffmpeg-static` / system `ffmpeg` — audio/video transcoding
- `node-pty` — terminal/PTY tools

### 5) Surface to the user

Send **one** brief message via the active channel. Format:

```
OpenClaw updated to <newVersion> (was <oldVersion>).

🆕 New for you:
- <bullet>
- <bullet>

⚠️ Breaking or removed:
- <bullet>

🔧 May need attention:
- ❌ sharp (image processing) — not installed; run: <install command>

Full notes: https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md
```

Hard cap: keep the whole message under ~15 lines. If a section is empty, drop it. If everything is quiet, send: `OpenClaw updated to <newVersion>. Nothing in the changelog requires action on my end.`

### 6) Persist new state

Write the new version + surfaced timestamp to the state file. Subsequent heartbeats compare against this and stay silent unless the version changes again.

## Voice

This is an operational notice, not a marketing email. Keep it terse, factual, and skip celebratory language.

- ✅ "OpenClaw updated to 2026.5.3-1. New: agent can now use the `talk` realtime voice tool. Watch: optional `sharp` is not installed; some image replies will fall back to original-size send."
- ❌ "🎉 Exciting news! OpenClaw has been upgraded with brand-new features..."

## Failure modes

- **CHANGELOG section missing for the new version** — fall back to a one-line "OpenClaw updated to vX. No detailed notes available yet; see GitHub Releases for raw notes." Do not hallucinate content.
- **No internet, no local copy** — same as above.
- **State file write fails** — log the error to today's memory file; surface still happens; next run will re-surface (acceptable noise vs silent miss).

## Why this exists

OpenClaw releases are well-documented in `CHANGELOG.md` and per-version GitHub Releases, but the running agent has no built-in mechanism to *consume* that information after an update. Real-world consequence: when an update introduces a new optional dependency requirement (e.g. `sharp` for image optimization), the user discovers it only when an unrelated workflow fails — typically in front of someone they care about.

This skill closes that loop. The CHANGELOG is the source of truth; this skill is the agent reading it on the user's behalf.
