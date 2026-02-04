---
name: dj-podcast
description: Podcast episode management from transcript to publication.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎙️",
        "requires": { "env": ["NOTION_API_KEY"] },
        "commands":
          [
            { "name": "podcast ingest", "description": "Ingest transcript for new episode" },
            { "name": "podcast pack", "description": "Generate episode pack" },
            { "name": "podcast status", "description": "Check episode status" },
            { "name": "podcast cache status", "description": "Check cache status" },
            { "name": "podcast draft-site", "description": "Create site draft from pack" },
          ],
      },
  }
---

# dj-podcast

Podcast episode management from transcript ingestion through content generation to site publishing.

## Usage

```
/podcast ingest <source> [--episode E###]
/podcast pack [latest|E###]
/podcast status [latest|E###]
/podcast cache status [latest|E###]
/podcast draft-site [latest|E###]
```

## Episode ID Scheme

Episodes use collision-proof sequential IDs: `E001`, `E002`, `E003`, etc.

- **Auto-allocated**: Default behavior, allocates next available ID
- **Override**: `--episode E042` to specify a specific ID (must not already exist)
- **State file**: `~/.openclaw/state/dj-podcast.json`

The episode counter increments atomically. If Notion creation fails immediately after allocation, the ID is rolled back.

## Local Storage

Episodes stored in `~/openclaw/dj/podcast/episodes/E###/`:

```
episodes/E001/
  transcript.txt      # Original transcript
  manifest.json       # Episode metadata + artifact versions
  pack/
    pack.json         # Generated pack (cached)
    show_notes_short.md
    show_notes_long.md
    titles.json
    chapters.json
    quotes.md
    clip_plan.md
    followup_email.md
```

All writes use atomic temp-file-then-rename to prevent corruption.

## Commands

### /podcast ingest

Ingest a transcript and create an episode record.

**Source types:**
- File path: `/podcast ingest /path/to/transcript.txt`
- URL: `/podcast ingest https://example.com/transcript`
- Notion page: `/podcast ingest notion://page/abc123`
- Clipboard/pasted text: `/podcast ingest` (then paste transcript)

**Override episode ID:**
```
/podcast ingest /path/to/transcript.txt --episode E042
```

**Workflow:**
1. Compute transcript hash (SHA256, first 16 characters)
2. Allocate episode ID (or verify override is available)
3. Save transcript and manifest locally
4. Create Notion Episode Pipeline entry (non-fatal on failure)

**Example:**
```
User: /podcast ingest ~/Downloads/ep42-transcript.txt

Cue: ✅ **Episode ingested**

Episode ID: E042
Transcript Hash: a1b2c3d4e5f67890
Local Path: ~/openclaw/dj/podcast/episodes/E042/

Next: /podcast pack E042
```

### /podcast pack

Generate the episode pack with titles, show notes, chapters, quotes, and clips.

```
/podcast pack E001
/podcast pack latest
/podcast pack   # defaults to latest
```

**Cache behavior:**
- Key: transcript hash (SHA256)
- If hash matches cached pack, returns cached result
- If hash differs or force regenerate, generates new pack

**Force regeneration:**
```
/podcast pack E001 --force
```

**Budget profiles:**

| Profile | Behavior |
|---------|----------|
| cheap | Basic pack, local model only |
| normal | Full pack with all artifacts |
| deep | Enhanced pack with polish pass |

**Example:**
```
User: /podcast pack E042

Cue: ✅ **Pack generated**

Episode: E042
Transcript Hash: a1b2c3d4...

**Titles:**
Safe (5): ...
Spicy (5): ...

**Show Notes:**
Short: 2-3 sentence summary
Long: Full markdown notes

**Chapters:** 5 chapters with timestamps
**Quotes:** 8 quotes extracted
**Clips:** 5 clips planned (hook, context, takeaway, CTA, highlight)

Next: /podcast draft-site E042
```

### /podcast status

Check episode status and manifest.

```
/podcast status E001
/podcast status latest
```

**Returns:**
- Episode ID and status (ingested, pack_pending, pack_complete, etc.)
- Transcript hash
- Source information
- Pack generation status
- Notion page IDs

**Example:**
```
User: /podcast status E042

Cue: 📊 **Episode Status**

Episode: E042
Status: pack_complete
Transcript Hash: a1b2c3d4...
Source: file (/path/to/transcript.txt)
Artifacts: titles (v1), showNotes (v1), chapters (v1), quotes (v1), clipPlan (v1)
Notion: Episode Pipeline (page-123), Assets (asset-456)
```

### /podcast cache status

Check cache status for an episode.

```
/podcast cache status E001
/podcast cache status latest
```

**Returns:**
- Whether pack is cached (local and/or Notion)
- Cache key (transcript hash)
- Notion asset ID if cached there

**Example:**
```
User: /podcast cache status E042

Cue: 🗄️ **Cache Status**

Episode: E042
Cached: Yes (locally)
Cache Key: a1b2c3d4e5f67890
Notion Asset: asset-456
```

### /podcast draft-site

Create a Squarespace draft post from the episode pack.

```
/podcast draft-site E001
/podcast draft-site latest
```

Uses `/site draft-post` with `template=episode` and populates from Notion `show_notes_long`.

**Never auto-publishes.** Squarespace publish always requires explicit approval.

**Example:**
```
User: /podcast draft-site E042

Cue: ✅ **Site draft created**

Episode: E042
Draft ID: draft-ep42-abc123
Template: episode

Edit in Squarespace: [link]

To publish: /site publish draft-ep42-abc123
```

## Episode Pack Artifacts

| Artifact | Description |
|----------|-------------|
| titles | Safe (5) + spicy (5) title options |
| show_notes_short | 2-3 sentence summary |
| show_notes_long | Full markdown show notes |
| chapters | Timestamped chapters (HH:MM:SS format) |
| quotes | Quote bank with speaker, timestamp, category |
| clip_plan | 5 clips: hook, context, takeaway, CTA, highlight |
| guest_followup | Email draft for guest follow-up |

### Title Categories

- **Safe**: Professional, descriptive titles suitable for all audiences
- **Spicy**: Attention-grabbing, provocative titles for marketing

### Clip Types

| Type | Purpose | Recommended Platform |
|------|---------|---------------------|
| hook | Attention-grabbing opener | Twitter |
| context | Sets up the main discussion | LinkedIn |
| takeaway | Actionable insight | Instagram |
| cta | Encourages engagement | TikTok |
| highlight | Most engaging moment | YouTube Shorts |

### Quote Categories

- `insight`: Key insights and wisdom
- `funny`: Humorous moments
- `controversial`: Bold or provocative statements
- `inspiring`: Motivational quotes

## Budget Integration

Pack generation respects budget limits:

| Profile | Tool Calls | Model Tier | Notes |
|---------|------------|------------|-------|
| cheap | 10 | local | Basic artifacts only |
| normal | 50 | standard | Full pack |
| deep | 200 | premium | Enhanced with polish pass |

**On budget exceeded:**
- Saves partial artifacts
- Updates manifest status to `pack_partial`
- Prompts user to arm deep mode to complete

## Caching

- **Key**: Transcript hash (SHA256, 16 chars)
- **Storage**: Local (`pack/pack.json`) + Notion (Podcast Assets DB)
- **Invalidation**: Content-based (no TTL)
- **Behavior**: If transcript changes, pack regenerates

## Notion Schema

### Episode Pipeline Database

| Property | Type | Description |
|----------|------|-------------|
| Name | Title | Episode ID (E001) |
| Title | Text | Episode title |
| Status | Select | Ingested/Pack Pending/Pack Complete/Draft Ready/Published |
| TranscriptHash | Text | SHA256 hash (16 chars) |
| SourceType | Select | file/url/notion/clipboard |
| SourcePath | Text | Original source path/URL |
| SquarespaceDraftId | Text | Draft ID if created |
| PublishedUrl | URL | Live URL if published |
| PublishedAt | Date | When published |
| CreatedAt | Date | When ingested |
| UpdatedAt | Date | Last update |
| LastError | Text | Error message if any |

### Podcast Assets Database

| Property | Type | Description |
|----------|------|-------------|
| Name | Title | E001-titles (episode-artifact) |
| EpisodeId | Text | Episode ID |
| TranscriptHash | Text | For cache key |
| ArtifactType | Select | titles/show_notes/chapters/quotes/clip_plan/full_pack |
| Content | Text | JSON content (truncated to 2000 chars) |
| CacheKey | Text | Transcript hash |
| Version | Number | Artifact version |
| Profile | Select | cheap/normal/deep |
| GeneratedAt | Date | When generated |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DJ_PODCAST_DIR` | `~/openclaw/dj/podcast` | Base directory for episodes |
| `DJ_NOTION_EPISODE_PIPELINE_DB_ID` | - | Episode Pipeline database ID |
| `DJ_NOTION_PODCAST_ASSETS_DB_ID` | - | Podcast Assets database ID |
| `DJ_PODCAST_PREFER_LOCAL` | `true` | Prefer local model for chunking |

## Monthly Cadence Cron

A monthly cron job runs on the 15th at 09:00 local time:

- **Profile**: Always `normal` (never deep)
- **Behavior**:
  - If no episode in progress: propose next episode plan + guest suggestions
  - If episode in progress: summarize status + propose next actions with deadlines

## Examples

### Full Workflow

```
# 1. Ingest transcript
/podcast ingest ~/Downloads/ep42-transcript.txt
> Episode E042 ingested (hash: a1b2c3d4...)

# 2. Generate pack
/podcast pack E042
> Pack generated for E042
> - 10 titles (5 safe, 5 spicy)
> - Show notes (short + long)
> - 12 chapters
> - 8 quotes
> - 5 clips planned

# 3. Create site draft
/podcast draft-site E042
> Draft created: draft-ep42-abc123

# 4. Publish (via /site)
/site publish draft-ep42-abc123
> Approval required for PUBLISH
> [After approval]
> Published: https://yoursite.com/blog/episode-42
```

### Override Episode ID

```
/podcast ingest --episode E100 ~/transcript.txt
> Episode E100 ingested
```

### Check if cached

```
/podcast cache status E042
> Cached: Yes (locally)
> Cache Key: a1b2c3d4e5f67890
```

### Resume from budget exceeded

```
/podcast pack E042
> Budget limit reached. Use deep mode to complete.

/budget deep
> Deep mode armed (expires in 30 minutes)

/podcast pack E042
> Pack completed for E042
```

## Notes

- Transcript hash is the canonical cache key (content-addressable)
- Pack regenerates only if transcript content changes
- Notion writes are non-fatal (logs locally and continues on failure)
- Squarespace publish always requires explicit approval
- Monthly cron never inherits deep mode
