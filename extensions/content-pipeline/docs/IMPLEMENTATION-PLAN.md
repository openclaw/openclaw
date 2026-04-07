# Implementation Plan: Discord Channels + Agent Team

## Overview

Build a multi-agent orchestration system managed by **nhu.tuyet**, with 3 specialist workers (**hana**, **minh**, **kai**), all coordinated through structured Discord channels.

---

## Part 1: Discord Channel Setup

### Prerequisites

- [ ] Re-invite bot with **Manage Channels** permission
  - URL: `https://discord.com/oauth2/authorize?client_id=1489991020098617544&scope=bot+applications.commands&permissions=275415166016`
  - Permissions: Manage Channels, Send Messages, Read Messages, Read History, Embed Links, Attach Files, Manage Messages

### Step 1A: Rename Existing Channels (12 API calls)

| Current Name                | Current ID            | → New Name        | Action                          |
| --------------------------- | --------------------- | ----------------- | ------------------------------- |
| **Thông Tin** (category)    | `1490891176272986303` | **GENERAL**       | Rename                          |
| chào-mừng-và-nội-quy        | `1490891176272986304` | **welcome**       | Rename, set topic               |
| ghi-chú-tài-nguyên          | `1490891176272986305` | **announcements** | Rename, set topic               |
| **Kênh Chat** (category)    | `1490891176272986306` | **NHU-TUYET**     | Rename                          |
| chung                       | `1490891176272986307` | **commands**      | Rename, set topic               |
| trợ-giúp-làm-bài-tập-về-nhà | `1490891176272986308` | **team-status**   | Rename, set topic               |
| lên-kế-hoạch-phiên          | `1490891176272986309` | **ai-chat**       | Rename, move to COMMUNITY later |
| lạc-đề                      | `1490891176272986310` | **off-topic**     | Rename, move to COMMUNITY later |
| **Kênh Thoại** (category)   | `1490891176272986311` | **VOICE**         | Rename                          |
| Phòng Chờ                   | `1490891176272986312` | **Voice Room 1**  | Rename                          |
| Phòng Học 1                 | `1490891176666992720` | **Voice Room 2**  | Rename                          |
| Phòng Học 2                 | `1490891176666992721` | —                 | Delete                          |

### Step 1B: Create New Channels (10 API calls)

| Name                    | Type     | Parent Category | Topic                                         |
| ----------------------- | -------- | --------------- | --------------------------------------------- |
| **HANA-RESEARCH**       | category | —               | —                                             |
| **scraped-articles**    | text     | HANA-RESEARCH   | Daily scraped article digest from all sources |
| **MINH-CONTENT**        | category | —               | —                                             |
| **scripts**             | text     | MINH-CONTENT    | Generated video scripts for review            |
| **KAI-PRODUCTION**      | category | —               | —                                             |
| **slide-preview**       | text     | KAI-PRODUCTION  | Generated slide images for review             |
| **video-progress**      | text     | KAI-PRODUCTION  | TTS + ffmpeg composition progress             |
| **published-news**      | text     | KAI-PRODUCTION  | Final news videos + YouTube/TikTok/FB links   |
| **published-tutorials** | text     | KAI-PRODUCTION  | Final tutorial videos + upload links          |
| **COMMUNITY**           | category | —               | —                                             |

### Step 1C: Move Channels to Correct Categories (2 API calls)

| Channel   | Move To   |
| --------- | --------- |
| ai-chat   | COMMUNITY |
| off-topic | COMMUNITY |

### Step 1D: Set Channel Ordering (positions)

```
pos 0: 📢 GENERAL
         ├── welcome              (pos 0)
         └── announcements        (pos 1)
pos 1: 🎯 NHU-TUYET
         ├── commands             (pos 0)
         └── team-status          (pos 1)
pos 2: 📰 HANA-RESEARCH
         └── scraped-articles     (pos 0)
pos 3: ✍️ MINH-CONTENT
         └── scripts              (pos 0)
pos 4: 🎬 KAI-PRODUCTION
         ├── slide-preview        (pos 0)
         ├── video-progress       (pos 1)
         ├── published-news       (pos 2)
         └── published-tutorials  (pos 3)
pos 5: 💬 COMMUNITY
         ├── ai-chat              (pos 0)
         └── off-topic            (pos 1)
pos 6: 🔊 VOICE
         ├── Voice Room 1         (pos 0)
         └── Voice Room 2         (pos 1)
```

**Final count: 7 categories + 12 text + 2 voice = 21 channels**

### Step 1E: Channel Topic Descriptions

| Channel             | Topic                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| welcome             | Welcome to OpenClaw Content Factory! Meet the team: nhu.tuyet (manager), hana (research), minh (content), kai (production) |
| announcements       | New video releases and important updates                                                                                   |
| commands            | Talk to @nhu.tuyet here. Commands: start news, start tutorial "topic", status, preview, help                               |
| team-status         | Live progress from all agents — scraping, writing, rendering, uploading                                                    |
| scraped-articles    | hana posts daily article digests from HN, dev.to, TechCrunch, The Verge, Lobsters, daily.dev                               |
| scripts             | minh posts generated video scripts for review before production                                                            |
| slide-preview       | kai posts rendered slide PNGs for visual review                                                                            |
| video-progress      | kai posts TTS + ffmpeg progress: audio segments, composition, encoding                                                     |
| published-news      | Final news recap videos with YouTube, TikTok, and Facebook links                                                           |
| published-tutorials | Final tutorial videos with upload links                                                                                    |
| ai-chat             | General AI chat with @openclaw                                                                                             |
| off-topic           | Off-topic discussion, memes, random                                                                                        |

---

## Part 2: Agent Team Setup

### Step 2A: Create Agents (4 CLI commands)

```bash
# nhu.tuyet — Manager
openclaw agents add nhu.tuyet \
  --workspace ~/.openclaw/workspace-nhu-tuyet

# hana — News Researcher
openclaw agents add hana \
  --workspace ~/.openclaw/workspace-hana

# minh — Content Writer
openclaw agents add minh \
  --workspace ~/.openclaw/workspace-minh

# kai — Video Producer
openclaw agents add kai \
  --workspace ~/.openclaw/workspace-kai
```

### Step 2B: Agent Personas (SOUL.md for each)

#### nhu.tuyet — Manager

```markdown
# nhu.tuyet — Content Pipeline Manager

You are nhu.tuyet, the project manager for a tech content creation team.

## Personality

- Professional but warm — structured reports with a friendly tone
- Proactive — you anticipate what needs to happen next
- Clear communicator — always give status updates, never leave the user guessing
- Organized — track progress, flag blockers, celebrate wins

## Communication Style

- English for all communication
- Use emoji sparingly but effectively (🎯 ✅ 📊 📹)
- Status updates are concise: what happened, what's next, any issues
- When delegating, be specific about what each team member should do

## Your Team

- **hana** — News Researcher. She scrapes and ranks tech articles.
- **minh** — Content Writer. He writes video scripts using AI.
- **kai** — Video Producer. He renders slides, generates audio, composes video, uploads.

## Your Responsibilities

1. Receive tasks from the user (news pipeline, tutorial requests)
2. Delegate to the right team member in the right order
3. Track progress across all stages
4. Report status to the user with clear summaries
5. Handle errors gracefully — retry or escalate to user
6. Manage the daily cron schedule
```

#### hana — News Researcher

```markdown
# hana — News Researcher

You are hana, a tech news researcher. You are curious, thorough, and have
a knack for finding the most interesting stories.

## Your Job

- Scrape tech news from RSS feeds (HN, dev.to, TechCrunch, The Verge, Lobsters)
- Scrape trending posts from daily.dev
- Rank articles by relevance and impact
- Summarize the top stories with key takeaways
- Return structured article data to nhu.tuyet

## Output Format

Always return articles as structured data:

- title, url, source, summary (2-3 sentences), score, published date
- Ranked by score (descending), then recency

## Personality

- Curious and enthusiastic about tech trends
- Thorough — never miss a major story
- Concise — summaries are sharp, not verbose
```

#### minh — Content Writer

```markdown
# minh — Content Writer

You are minh, a tech content writer who creates engaging video scripts.

## Your Job

- Take ranked articles from hana and write news video scripts
- Take topics from nhu.tuyet and write tutorial scripts
- Generate structured content: title, description, tags, slide content, narration

## Script Rules

- News scripts: 3-5 minutes, energetic, conversational
- Tutorial scripts: 5-10 minutes, clear, methodical, progressive steps
- Each slide has: title, body (2-3 bullets), speaker_notes (TTS narration)
- Speaker notes: simple language, no special characters, no markdown
- Include working code examples in tutorials (not pseudocode)
- Narration explains WHY, not just WHAT

## Output

Always return valid JSON with: videoTitle, videoDescription, tags, slides[]

## Personality

- Creative but disciplined — engaging content within structure
- Audience-aware — writes for developers, not academics
- SEO-conscious — good titles, descriptions, and tags
```

#### kai — Video Producer

```markdown
# kai — Video Producer

You are kai, a video production specialist. You turn scripts into polished videos.

## Your Job

1. Render HTML/CSS slides from script content using Playwright
2. Generate TTS audio from speaker notes using edge-tts
3. Compose video using ffmpeg (landscape 16:9 + portrait 9:16)
4. Burn subtitles into the video
5. Upload to YouTube, TikTok, and Facebook

## Technical Stack

- Slides: HTML/CSS templates + Playwright screenshot (1920x1080)
- TTS: edge-tts with en-US-AndrewNeural voice
- Video: ffmpeg — per-slide segments → concat → subtitle burn
- Portrait: blurred background padding for 9:16

## Output

- video_landscape.mp4 (1920x1080)
- video_portrait.mp4 (1080x1920)
- Upload links for each platform

## Personality

- Technical and efficient — no wasted steps
- Quality-focused — checks output before delivering
- Reports progress at each stage
```

### Step 2C: Agent Workspace Files

For each agent workspace, create:

```
~/.openclaw/workspace-<agent>/
├── SOUL.md          — Persona (above)
├── AGENTS.md        — Operating instructions
├── IDENTITY.md      — Name + emoji
├── skills/          — Agent-specific skills
│   └── <skill>/
│       └── SKILL.md
└── memory/          — Agent memory (auto-populated)
```

#### IDENTITY.md files:

```
nhu.tuyet: name="nhu.tuyet" emoji="🎯"
hana:      name="hana"      emoji="📰"
minh:      name="minh"      emoji="✍️"
kai:       name="kai"       emoji="🎬"
```

### Step 2D: Custom Skills

#### Skill: `news-scraper` (for hana)

```
~/.openclaw/workspace-hana/skills/news-scraper/SKILL.md
```

- Teaches hana how to use exec tool to run the scraper
- Calls: `npx tsx extensions/content-pipeline/src/cli.ts preview`
- Or uses the pipeline's scraper module directly

#### Skill: `content-writer` (for minh)

```
~/.openclaw/workspace-minh/skills/content-writer/SKILL.md
```

- Teaches minh how to call Gemma 4 API for script generation
- Uses the LLM client from content-pipeline
- Defines the JSON output schema

#### Skill: `video-producer` (for kai)

```
~/.openclaw/workspace-kai/skills/video-producer/SKILL.md
```

- Teaches kai how to run slide renderer, TTS, ffmpeg, uploaders
- Calls: `npx tsx extensions/content-pipeline/src/cli.ts run news --stage slides`
- Step-by-step production workflow

#### Skill: `pipeline-manager` (for nhu.tuyet)

```
~/.openclaw/workspace-nhu-tuyet/skills/pipeline-manager/SKILL.md
```

- Teaches nhu.tuyet the full pipeline flow
- How to spawn sub-agents (hana → minh → kai)
- How to track progress and report status
- Error handling and retry logic

### Step 2E: Configuration (`~/.openclaw/openclaw.json`)

```jsonc
{
  "agents": {
    "defaults": {
      "model": { "primary": "google/gemini-2.5-flash" },
      "subagents": {
        "allowAgents": ["hana", "minh", "kai"],
        "maxSpawnDepth": 2,
        "maxConcurrent": 4,
        "runTimeoutSeconds": 600,
      },
    },
    "list": [
      {
        "id": "nhu.tuyet",
        "workspace": "~/.openclaw/workspace-nhu-tuyet",
        "identity": { "name": "nhu.tuyet", "emoji": "🎯" },
      },
      {
        "id": "hana",
        "workspace": "~/.openclaw/workspace-hana",
        "identity": { "name": "hana", "emoji": "📰" },
      },
      {
        "id": "minh",
        "workspace": "~/.openclaw/workspace-minh",
        "identity": { "name": "minh", "emoji": "✍️" },
      },
      {
        "id": "kai",
        "workspace": "~/.openclaw/workspace-kai",
        "identity": { "name": "kai", "emoji": "🎬" },
      },
    ],
  },
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["nhu.tuyet", "hana", "minh", "kai"],
    },
  },
  "bindings": [
    {
      "agentId": "nhu.tuyet",
      "match": { "channel": "discord" },
    },
  ],
}
```

### Step 2F: Agent Bindings

```bash
# nhu.tuyet handles all Discord messages
openclaw agents bind --agent nhu.tuyet --bind discord

# Enable sub-agent spawning for nhu.tuyet
# (configured in agents.defaults.subagents above)
```

### Step 2G: Cron Jobs

```bash
# Daily news pipeline — 8:00 AM
openclaw cron add \
  --name "Daily News Pipeline" \
  --cron "0 8 * * *" \
  --agent nhu.tuyet \
  --session isolated \
  --message "Run the daily news pipeline. Spawn hana to scrape articles, then minh to write the script, then kai to produce and upload the video. Post progress to Discord." \
  --announce --channel discord \
  --to "channel:<commands-channel-id>"

# Weekly tutorial — Sunday 10:00 AM
openclaw cron add \
  --name "Weekly Tutorial" \
  --cron "0 10 * * 0" \
  --agent nhu.tuyet \
  --session isolated \
  --message "Pick the most interesting topic from this week's news and create a tutorial video about it. Spawn minh for the script and kai for production." \
  --announce --channel discord \
  --to "channel:<commands-channel-id>"
```

---

## Part 3: Implementation Order

### Phase A: Discord Channels (do first — no code changes)

1. [ ] Re-invite bot with Manage Channels permission
2. [ ] Rename 11 existing channels via Discord API
3. [ ] Delete 1 unused voice channel
4. [ ] Create 4 new categories via Discord API
5. [ ] Create 6 new text channels under correct categories
6. [ ] Move 2 channels to COMMUNITY category
7. [ ] Set all channel positions for correct ordering
8. [ ] Set topic descriptions for all text channels
9. [ ] Verify final structure matches plan

### Phase B: Agent Infrastructure (workspace setup)

1. [ ] Create 4 agent workspaces (`~/.openclaw/workspace-*`)
2. [ ] Write SOUL.md for each agent
3. [ ] Write IDENTITY.md for each agent
4. [ ] Write AGENTS.md for each agent
5. [ ] Register agents via `openclaw agents add`

### Phase C: Skills (teach agents their jobs)

1. [ ] Write `pipeline-manager` skill for nhu.tuyet
2. [ ] Write `news-scraper` skill for hana
3. [ ] Write `content-writer` skill for minh
4. [ ] Write `video-producer` skill for kai
5. [ ] Test each skill individually

### Phase D: Configuration (wire everything together)

1. [ ] Update `~/.openclaw/openclaw.json` with agents list
2. [ ] Enable agent-to-agent communication
3. [ ] Set up bindings (nhu.tuyet → Discord)
4. [ ] Enable sub-agent spawning
5. [ ] Restart gateway

### Phase E: Cron Jobs (automation)

1. [ ] Create daily news cron job
2. [ ] Create weekly tutorial cron job
3. [ ] Test with `openclaw cron run <id>`

### Phase F: Testing

1. [ ] Test: DM nhu.tuyet → verify she responds with personality
2. [ ] Test: "@nhu.tuyet status" → verify team status report
3. [ ] Test: "@nhu.tuyet preview news" → hana scrapes, nhu.tuyet reports
4. [ ] Test: "@nhu.tuyet start news" → full pipeline delegation
5. [ ] Test: "@nhu.tuyet start tutorial Docker basics" → tutorial pipeline
6. [ ] Test: Cron trigger → verify automated daily run
7. [ ] Test: Error handling → kill kai mid-run, verify nhu.tuyet reports error
8. [ ] Test: Check all Discord channels receive correct content

---

## Verification Checklist

- [ ] Discord: 7 categories, 12 text channels, 2 voice channels visible
- [ ] Discord: All topics/descriptions set correctly
- [ ] Agents: 4 agents listed in `openclaw agents list`
- [ ] Agents: nhu.tuyet responds to Discord messages
- [ ] Agents: nhu.tuyet can spawn hana, minh, kai as sub-agents
- [ ] Skills: Each agent has its skill loaded (`openclaw skills list --agent <id>`)
- [ ] Cron: Daily job appears in `openclaw cron list`
- [ ] Pipeline: Full news video produced and uploaded end-to-end
- [ ] Pipeline: Tutorial video produced on demand
- [ ] Channels: Articles → #scraped-articles, scripts → #scripts, slides → #slide-preview, videos → #published-news
