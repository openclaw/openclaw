---
name: launch-directories
description: Submit startups to Product Hunt, Hacker News, BetaList, and 40+ launch directories. Supports API and form-based submissions.
homepage: https://github.com/dbhurley/launch-directories
metadata:
  openclaw:
    emoji: "🚀"
    requires:
      bins: ["python3"]
    env:
      PRODUCTHUNT_TOKEN: "Product Hunt API token (optional)"
      BETALIST_TOKEN: "BetaList API token (optional)"
---

# Launch Directories 🚀

Submit your startup to 40+ directories and launch platforms with a single command.

## Quick Start

```bash
# List all supported directories
python3 skills/launch-directories/scripts/launch.py list

# Submit to a specific directory
python3 skills/launch-directories/scripts/launch.py submit producthunt \
  --name "SaveState" \
  --tagline "Time Machine for AI Agents" \
  --url "https://savestate.dev" \
  --description "Encrypted backup and restore for AI agent state"

# Submit to multiple directories
python3 skills/launch-directories/scripts/launch.py submit-all \
  --name "MeshGuard" \
  --tagline "The Okta for AI Agents" \
  --url "https://meshguard.app" \
  --tier 1  # Only high-impact directories

# Check submission status
python3 skills/launch-directories/scripts/launch.py status
```

## Supported Directories

### Tier 1 — High Impact (API or Direct)
| Platform | Method | Env Key |
|----------|--------|---------|
| Product Hunt | API | `PRODUCTHUNT_TOKEN` |
| Hacker News | Browser | — |
| Reddit | API | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| Indie Hackers | Form | — |
| BetaList | API | `BETALIST_TOKEN` |
| Dev Hunt | Form | — |

### Tier 2 — Solid Directories (Form-based)
| Platform | Method | Notes |
|----------|--------|-------|
| SaaSHub | Form | SaaS alternatives |
| Uneed | Form | Curated tools |
| PeerList | Form | Professional network |
| Foundrlist | Form | Founder community |
| Micro Launch | Form | Daily launches |
| Directory Hunt | Form | Meta-directory |

### Tier 3 — AI-Focused (Form-based)
| Platform | Method | Notes |
|----------|--------|-------|
| AI Launch | Form | AI products |
| AItoolonline | Form | AI tools |
| There's An AI For That | Form | Large AI directory |
| ShowMeBestAI | Form | AI showcase |

### Tier 4 — Niche & Emerging
See full list with `launch.py list --all`

## Commands

### `list` — Show available directories
```bash
# List all directories
python3 launch.py list

# Filter by tier
python3 launch.py list --tier 1

# Filter by method (api, form, browser)
python3 launch.py list --method api

# Show AI-focused only
python3 launch.py list --category ai
```

### `submit` — Submit to one directory
```bash
python3 launch.py submit <platform> \
  --name "Product Name" \
  --tagline "Short tagline" \
  --url "https://example.com" \
  --description "Longer description" \
  --logo "/path/to/logo.png" \
  --screenshots "/path/to/screenshot1.png,/path/to/screenshot2.png" \
  --categories "developer-tools,saas" \
  --makers "twitter:@handle"
```

### `submit-all` — Submit to multiple directories
```bash
# Submit to all tier 1 directories
python3 launch.py submit-all --tier 1 --name "..." --url "..."

# Submit to specific list
python3 launch.py submit-all --platforms producthunt,betalist,saashub --name "..."

# Dry run (show what would be submitted)
python3 launch.py submit-all --tier 1 --dry-run
```

### `status` — Check submission status
```bash
# Show all submissions
python3 launch.py status

# Filter by startup
python3 launch.py status --name "MeshGuard"

# Show pending only
python3 launch.py status --pending
```

## Environment Variables

Set these for API-based submissions:

```bash
# Product Hunt (get from producthunt.com/v2/oauth/applications)
export PRODUCTHUNT_TOKEN="your_token"

# BetaList
export BETALIST_TOKEN="your_token"

# Reddit (for r/SideProject, etc.)
export REDDIT_CLIENT_ID="your_id"
export REDDIT_CLIENT_SECRET="your_secret"
export REDDIT_USERNAME="your_username"
export REDDIT_PASSWORD="your_password"
```

## Submission Data File

For repeated submissions, create a JSON file:

```json
{
  "name": "SaveState",
  "tagline": "Time Machine for AI Agents",
  "url": "https://savestate.dev",
  "description": "Encrypted backup and restore for AI agent state. CLI tool with cloud sync.",
  "logo": "/path/to/logo.png",
  "screenshots": [
    "/path/to/screenshot1.png",
    "/path/to/screenshot2.png"
  ],
  "categories": ["developer-tools", "ai", "backup"],
  "makers": ["twitter:@savestatedev"],
  "pricing": "freemium",
  "launched": "2026-01-27"
}
```

Then submit:
```bash
python3 launch.py submit producthunt --data savestate.json
python3 launch.py submit-all --tier 1 --data savestate.json
```

## Launch Checklist

### Pre-Launch (1-2 weeks before)
- [ ] Prepare logo (square, high-res)
- [ ] Create 3-5 screenshots/GIFs
- [ ] Record demo video (optional)
- [ ] Write tagline (<60 chars)
- [ ] Write description (150-300 words)
- [ ] Create accounts on target platforms
- [ ] Schedule Product Hunt (Tuesday-Thursday)

### Launch Day
- [ ] `submit producthunt` at 12:01 AM PT
- [ ] Post Show HN
- [ ] Submit to tier 1 directories
- [ ] Share on Twitter, LinkedIn
- [ ] Respond to all comments quickly

### Post-Launch (1-2 weeks after)
- [ ] Submit to tier 2-4 directories
- [ ] `status` to track progress
- [ ] Collect testimonials
- [ ] Write retrospective

## Platform-Specific Tips

### Product Hunt
- Launch Tuesday-Thursday
- First comment is crucial
- Respond to every comment
- Have supporters ready

### Hacker News
- Title: "Show HN: [Name] – [Description]"
- Be technical, genuine
- Handle criticism gracefully

### Reddit
- Follow subreddit rules
- r/SideProject most welcoming
- Provide value, not just promo

---

*Coordinate launches through PM. Tag @nc_pm_bot for planning.*
