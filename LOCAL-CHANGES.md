# Local Changes

This file documents modifications to this OpenClaw installation that are not (yet)
part of upstream. All changes are committed as local git commits that ride on top
of `origin/main` and rebase cleanly on `git pull --rebase`.

**For agents**: before editing anything in `src/tts/tts.ts`, `src/config/types.tts.ts`,
`src/config/zod-schema.core.ts`, or `src/auto-reply/reply/session.ts` — read this
file first. Those files contain local patches.

---

## Local Commits (newest first)

### 5–6. fix: add missing `forward` TypeScript type and Zod schema (post-update bugfix)

**Commits**: `7be873c` (TypeScript type), `4e919b6` (Zod schema)
**Status**: Local only (fixes to commits 3–4 below)

After a `git pull --rebase` onto upstream `2026.3.14`, the gateway crash-looped
on startup with:

```
Config invalid
  - messages.tts: Unrecognized key: "forward"
```

Root cause: commit 3 added the `forward` runtime logic but never updated the Zod
schema. `TtsConfigSchema` uses `.strict()`, so any unrecognised key is a hard
rejection at gateway startup.

**Files changed**:

- `src/config/types.tts.ts` — adds `forward?: { enabled?, command?, timeoutMs? }` to `TtsConfig`
- `src/config/zod-schema.core.ts` — adds `forward` object shape to `TtsConfigSchema`

---

### 3–4. TTS: implement forward command for post-generation audio delivery

**Commits**: `648cde2` (implementation), `7a684d0` (docs)
**Status**: Submitted upstream as PR #30114

Adds a generic `{{file}}` shell command hook that fires (fire-and-forget) after
each TTS audio file is generated. Config at `messages.tts.forward`:

```json
"forward": {
  "enabled": true,
  "command": "scp {{file}} host:path && ssh host media-player play path",
  "timeoutMs": 15000
}
```

**Files changed**:

- `src/tts/tts.ts` — adds `shellEscape()`, `substituteShellSafe()`, `maybeForwardTtsAudio()`,
  calls it fire-and-forget in `maybeApplyTtsToPayload` after a successful TTS result
- `src/agents/openclaw-tools.ts` — mentions forward in TTS tool description
- `src/agents/tools/tts-tool.ts` — forward in tool schema

---

### 2. Add TTS post-process speed setting

**Commit**: `d7ec70a`
**Status**: Local only

Adds `messages.tts.postProcess.speed` — a playback speed multiplier applied via
ffmpeg's `atempo` filter after audio generation (range 0.5–2.0). Useful for
slightly speeding up speech without pitch shift.

```json
"postProcess": { "speed": 1.15 }
```

**Files changed**:

- `src/tts/tts.ts` — adds `applyPostProcessSpeed()` using `execFile`/ffmpeg,
  `postProcess?: { speed? }` in `ResolvedTtsConfig`, integration in `resolveTtsConfig()`
- `src/config/types.tts.ts` — adds `postProcess?: { speed?: number }` to `TtsConfig`

---

### 1. Add optional markdown stripping for TTS

**Commit**: `e88536c`
**Status**: Local only

Adds `messages.tts.stripMarkdown: true` — strips Markdown syntax (headings, bold,
bullet points, etc.) from text before sending to TTS, so the voice output doesn't
say "hashtag hashtag" for `## Headings`.

**Files changed**:

- `src/tts/tts.ts` — adds `stripMarkdownForTts()`, `stripMarkdown: boolean` in
  `ResolvedTtsConfig`, and applies it in `maybeApplyTtsToPayload`
- `src/config/types.tts.ts` — adds `stripMarkdown?: boolean` to `TtsConfig`
- `extensions/matrix/src/matrix/monitor/handler.ts` — minor related change
- `src/auto-reply/reply/inbound-meta.ts` — minor related change
- `src/auto-reply/reply/session.ts` — adds `session:expired` hook emission when
  a session is implicitly reset due to idle timeout (distinct from manual `/new`/`/reset`)

---

## Working-tree Changes (unstaged, not committed)

### .npmrc

Self-contained pnpm paths — avoids writing to user home directories:

```
store-dir=/opt/openclaw/.pnpm-store
cache-dir=/opt/openclaw/.pnpm-cache
```

---

## Build & Ops Notes

### Critical: always build as `openclaw` user

```bash
sudo -u openclaw pnpm build
```

**Why**: `ryer` (the admin user) has Node v24 via nvm. The bundler (rolldown rc.3)
generates `await` inside non-async function bodies when run under Node v24 — a
rolldown bug that V8 13.x (Node 24) silently accepts but V8 12.x (Node 22) correctly
rejects with `SyntaxError: Unexpected reserved word`. The `openclaw` user's PATH
picks up `/usr/bin/node` v22.22.0 via the `#!/usr/bin/env node` shebang in
`/usr/local/bin/pnpm`, producing correct output.

Symptom if you build as `ryer`: the gateway/TUI fails at startup with:

```
SyntaxError: Unexpected reserved word
    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)
```

### Update procedure (summary)

```bash
# 1. Permissions
sudo find /opt/openclaw/.git -not -perm -g+w -exec chmod g+w {} \;

# 2. Stash working-tree changes (e.g. .npmrc)
git -C /opt/openclaw stash

# 3. Rebase local commits onto upstream
git -C /opt/openclaw pull --rebase

# 4. Restore stash
git -C /opt/openclaw stash pop

# 5. Install deps (as openclaw — needed to chmod bin symlinks it owns)
sudo -u openclaw pnpm install

# 6. Build (as openclaw — Node v22 required, see above)
sudo -u openclaw pnpm build

# 7. Restart
sudo systemctl restart openclaw-gateway.service
```

Full details (including conflict resolution notes): see Claude's memory at
`~/.claude/projects/-opt-openclaw/memory/updating.md`.

### Config location

- **Config file**: `/etc/openclaw/openclaw.json`
- **TTS config key**: `messages.tts` (NOT root `tts` — that crashes the gateway)
- **Config backup**: `/etc/openclaw/openclaw.json.bak`
- **State dir**: `/var/lib/openclaw`

### Active TTS config

```json
{
  "auto": "always",
  "provider": "edge",
  "stripMarkdown": true,
  "edge": {
    "enabled": true,
    "voice": "en-AU-NatashaNeural",
    "rate": "-10%"
  },
  "forward": {
    "enabled": true,
    "command": "scp {{file}} p8ar:/data/data/com.termux/files/home/.cache/sam-listener/clip.mp3 && ssh p8ar termux-media-player play /data/data/com.termux/files/home/.cache/sam-listener/clip.mp3",
    "timeoutMs": 15000
  }
}
```
