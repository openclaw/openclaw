---
name: ersatztv
description: Build and manage ErsatzTV channel lineups using the ETV2 CP-SAT solver. Use when asked to create, rebuild, or modify ErsatzTV channels, generate playlists, probe media durations, write NFO metadata, or manage content on the NUC media server.
---

# ErsatzTV Channel Management

## Project Location

All ETV tooling lives at: `/Users/rabsef-bicrym/clawd/projects/ersatztv/`

Key subdirectories:

- `etv2/` — CP-SAT solver suite (the primary tool)
- `etv2/examples/` — Channel config JSONs (television.json, etc.)
- `etv2/docs/` — Full documentation
- `configs/` — Generated YAML lineups
- `scripts/` — Legacy scripts (etv_channel_builder.py still used by etv2)

## NUC Connection

- SSH: `ssh -i ~/.ssh/talwet rabsef-bicrym@192.168.50.188`
- ETV DB: `/mnt/media/config/ersatztv.sqlite3` (root-owned, needs `sudo` for writes)
- Media root (host): `/mnt/media/`
- Media root (ETV container): `/media/`
- Prefix rewrite for probing: `--rewrite-prefix "/mnt/media=/media"`

## End-to-End Workflow

Read `etv2/docs/TELEVISION_RUNBOOK.md` for the exact step-by-step. Summary:

```bash
cd /Users/rabsef-bicrym/clawd/projects/ersatztv
source .venv/bin/activate

# 1. Probe durations (if new content added)
python etv2/bin/etv2_probe_dir.py \
  --ssh "ssh -i ~/.ssh/talwet rabsef-bicrym@192.168.50.188" \
  --dir "/mnt/media/other_videos/DIRNAME" \
  --rewrite-prefix "/mnt/media=/media" \
  --type other_video \
  --out /tmp/probed.json

# 2. Solve
python etv2/bin/etv2_solve.py \
  --config etv2/examples/CHANNEL.json \
  --out /tmp/channel.yaml \
  --report /tmp/channel.report.json

# 3. Verify
python etv2/bin/etv2_verify.py \
  --config etv2/examples/CHANNEL.json \
  --yaml /tmp/channel.yaml

# 4. Dry-run (requires DB access)
python etv2/bin/etv2_channel_builder.py /tmp/channel.yaml \
  --dry-run \
  --ssh "ssh -i ~/.ssh/talwet rabsef-bicrym@192.168.50.188"

# 5. Apply
python etv2/bin/etv2_channel_builder.py /tmp/channel.yaml \
  --apply \
  --ssh "ssh -i ~/.ssh/talwet rabsef-bicrym@192.168.50.188"
```

## Venv Setup (one-time)

```bash
cd /Users/rabsef-bicrym/clawd/projects/ersatztv
python3 -m venv .venv
source .venv/bin/activate
pip install -r etv2/requirements.txt
```

## Documentation Index

For detailed reference, read these files from `etv2/docs/`:

- `STEP_BY_STEP.md` — Full walkthrough from zero
- `CONFIG.md` — Every config field explained
- `CONCEPTS.md` — Solver strategy and terminology
- `PROBING.md` — Getting real durations via ffprobe
- `TROUBLESHOOTING.md` — Common failures and fixes
- `TELEVISION_RUNBOOK.md` — Exact commands for Television channel

## Critical Rules

1. **Never write to ETV DB without explicit permission.** Show findings, ask before modifying.
2. **Rename mp4 + NFO as a pair.** Never rename one without the other.
3. **Library path changes require drop → save → re-add in ETV UI** (rescan alone won't purge stale entries).
4. **Paths in config must match ETV container paths** (`/media/...`), not host paths (`/mnt/media/...`).
5. **Solver time_limit_sec is per phase** (2 phases). A 60s limit can take ~120s total.
6. **Sequential pools require SxxExx in filenames.** If files lack this, rename them first.

## NFO Writing

When writing NFOs for media files:

- Use `<episodedetails>` for TV episodes, `<movie>` for movies/shorts
- Include: title, year, plot, genre, director, credits, studio
- For episodes: also include showtitle, season, episode, aired
- Match NFO filename exactly to video filename (minus extension)
- Write NFOs and rename videos atomically — never leave orphaned NFOs

## Channel Registry

| Ch  | Name         | Config                        | DB ChannelId | PlaylistId |
| --- | ------------ | ----------------------------- | ------------ | ---------- |
| 1   | The Prisoner | — (manually configured)       | 1            | —          |
| 2   | Television   | etv2/examples/television.json | 5            | 4          |
| 3   | Oddities     | etv2/examples/oddities.json   | 6            | 5          |

## Symlinks Don't Work in Docker

ETV runs in Docker. Host paths (`/mnt/media/...`) don't exist inside the container (mounted as `/media/...`). Absolute symlinks break — ETV sees zero duration. Use copies or relative symlinks instead.

## Playout Update Gotcha

After applying new playlist items via the builder, the API playout reset (`POST /api/channels/{n}/playout/reset`) may not reliably pick up changes. The reliable method is to **remove and re-add the playlist in the ETV player UI**.
