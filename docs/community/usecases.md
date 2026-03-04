---
summary: "Community use cases and recommended skills from awesome-openclaw-usecases"
title: "Community use cases"
---

# Community use cases

This page links to the [awesome-openclaw-usecases](https://github.com/hesamsheikh/awesome-openclaw-usecases) collection and lists recommended skills for specific workflows. Each use case describes how to combine OpenClaw with skills to solve real problems.

## Recommended skills by category (bundled when running from repo)

When you run OpenClaw from the **local repo** (e.g. after `git clone` + `pnpm install`), the following eight skills are **bundled** under `skills/` and load as **openclaw-bundled** — no extra install. Configure API keys or env where noted.

| Skill                | Description                                                 | Notes                                                                                       |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **agent-browser**    | 自动操作浏览器 — automate browsing (click, type, snapshot). | Uses built-in [browser](/tools/browser) tool. No API key.                                   |
| **brave-search**     | 智能搜索 — real-time web search (Brave Search API).         | Set `BRAVE_API_KEY` or `skills.entries["brave-search"].apiKey`.                             |
| **xai**              | Grok chat + X search (社媒).                                | Set `XAI_API_KEY` or `skills.entries.xai.apiKey`. Scripts: chat.js, search-x.js, models.js. |
| **search-x**         | Twitter/X search (Grok or X API).                           | Same key as xai for Grok; or `X_BEARER_TOKEN` for native X API.                             |
| **coding-agent**     | 编程助手 — delegate to Codex/Claude Code/Pi.                | Requires `claude` / `codex` / `opencode` / `pi` binary.                                     |
| **image-gen**        | 图像生成 — text-to-image.                                   | Points to openai-image-gen / nano-banana-pro. Set OpenAI or Gemini API key.                 |
| **github-ai-trends** | AI 趋势追踪 — GitHub trending AI repos.                     | Requires `gh` CLI; run `gh auth login`.                                                     |
| **cron**             | 定时任务 — scheduled runs.                                  | Built-in [Cron](/automation/cron-jobs); no key.                                             |
| **memory**           | 长期记忆 — durable memory.                                  | Built-in [Memory](/concepts/memory); optional `memorySearch` provider.                      |

For **npm/installed** OpenClaw, bundled skills come from the package; the same eight are included when the package ships the `skills/` directory. ClawHub and `openclaw skills add <url>` remain for additional skills. See [Skills](/tools/skills).

## Use cases and required skills

| Use case                              | Description                                                                                                               | Skill(s)                                                    | How to install                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Personal Knowledge Base (RAG)**     | Build a searchable knowledge base from URLs, tweets, and articles you drop into chat. Semantic search over saved content. | knowledge-base, web_fetch (built-in)                        | ClawHub: `npx clawhub@latest install knowledge-base` (or equivalent slug from [clawhub.com](https://clawhub.com)). No public Git repo.                                                     |
| **Market Research & Product Factory** | Mine Reddit and X for real pain points over the last 30 days, then have OpenClaw build MVPs that solve them.              | [Last 30 Days](https://github.com/matvanhorde/last-30-days) | **Git:** `openclaw skills add https://github.com/matvanhorde/last-30-days` (if the repo is available; otherwise check [openclaw/skills](https://github.com/openclaw/skills) for a backup). |
| **Daily Reddit Digest**               | Get a curated digest of top posts from your favourite subreddits (read-only; no posting/voting).                          | reddit-readonly                                             | ClawHub: `npx clawhub@latest install reddit-readonly` (or buksan1950/reddit-readonly slug). No public Git repo.                                                                            |
| **Daily YouTube Digest**              | Get daily summaries of new videos from your favorite channels; fetch transcripts and key insights.                        | youtube-full                                                | ClawHub: `npx clawhub@latest install youtube-full` (or therohitdas/youtube-full slug). No public Git repo.                                                                                 |
| **Twitter/X AI monitoring**           | Monitor and analyze X/Twitter for AI industry, applications, research, and key people/companies. Daily or on-demand.      | xai (Grok), search-x (Grok/X API)                           | See [Installing skills from the openclaw/skills archive](#installing-skills-from-the-openclawskills-archive) below.                                                                        |

ClawHub installs go to `./skills` under your current directory (or your OpenClaw workspace). OpenClaw loads them as workspace skills on the next session. See [ClawHub](/tools/clawhub).

## Install skills from the 70 use cases (Awesome OpenClaw)

The [EvoLinkAI/awesome-openclaw-usecases-moltbook](https://github.com/EvoLinkAI/awesome-openclaw-usecases-moltbook) collection documents 70 use cases (daily life, content conversion, memory, night automation, data analysis, security, tooling). Each use case lists **Skills You Need** with links to [ClawHub](https://clawhub.ai) (e.g. `clawhub.ai/skills/<slug>`).

To install **all ClawHub skills** referenced in those use cases in one go, from the OpenClaw repo root run:

```bash
./scripts/install-usecase-skills.sh
```

This script clones the use-case repo (if needed), parses every `usecases/*.md` for ClawHub skill links, deduplicates them, and runs `npx clawhub@latest install <slug>` for each. Skills are installed into `./skills` (or `OPENCLAW_SKILLS_DIR` / `$OPENCLAW_CONFIG_DIR/skills` if set). To only list slugs without installing, run:

```bash
DRY_RUN=1 ./scripts/install-usecase-skills.sh
```

**Prerequisite:** [ClawHub](https://clawhub.com) CLI (`npm i -g clawhub` or `pnpm add -g clawhub`). Some skills may require login or may be private; the script continues on failure for individual slugs. As of the latest use-case snapshot, the unique slugs found are: `agentmail-wrapper`, `beware-piper-tts`, `calendar`, `claw-fi`, `execute-swap`, `git`, `hacker-news`, `mem`, `memory-search`, `qwen-image-skill`, `searching-assistant`. You can install any subset manually with `clawhub install <slug>`.

## Installing skills from the openclaw/skills archive

The [openclaw/skills](https://github.com/openclaw/skills) repository is an archive of skills from [clawhub.com](https://clawhub.com). Skills live in subfolders `skills/<owner>/<skill-name>/`. To use **xai** (Grok API) or **search-x** (Grok/X API) for Twitter/X search, you must copy those skill folders into your managed or workspace skills directory so OpenClaw sees them as top-level skill folders (each with a `SKILL.md`).

### Option A: Run the setup script (recommended)

From the OpenClaw repo root:

```bash
./scripts/setup-community-skills.sh
```

This clones the archive (if needed), copies **xai** and **search-x** (from the mvanhorn skill set in the archive) into your skills directory, and runs dependency install where needed. You can override the target directory with `OPENCLAW_SKILLS_DIR` or set `OPENCLAW_CONFIG_DIR` so the script uses `$OPENCLAW_CONFIG_DIR/skills`.

### Option B: Manual steps

1. Clone the archive: `git clone --depth 1 https://github.com/openclaw/skills.git /tmp/openclaw-skills`
2. Copy the skill folders into your managed skills dir (e.g. `~/.openclaw/skills` or `$OPENCLAW_CONFIG_DIR/skills`). The archive uses `skills/<owner>/<skill-name>/`; copy the inner skill dirs as top-level names:
   - `cp -r /tmp/openclaw-skills/skills/mvanhorn/xai ~/.openclaw/skills/`
   - `cp -r /tmp/openclaw-skills/skills/mvanhorn/search-x ~/.openclaw/skills/`
3. If a skill has `package.json`, run `npm install --omit=dev` (or your preferred node manager) inside that skill directory.

After that, restart the gateway or start a new session; the new skills will appear in `openclaw skills list` and in the Control UI.

## Environment and API keys

- **xai**: Typically requires `XAI_API_KEY` (Grok API).
- **search-x**: May require X API credentials or Grok (XAI); check the skill’s `SKILL.md` for `metadata.openclaw.requires`.
- **Last 30 Days**: Optional API keys (e.g. OpenAI, xAI) for full access; can fall back to web-only mode.

Set API keys in `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>.apiKey` or via the Control UI Skills page.

## Development and testing

- To use a project-local skills directory, set `OPENCLAW_CONFIG_DIR` to a path under your repo (e.g. `./.openclaw`) before running `openclaw skills add` or the setup script. Skills will then live under `$OPENCLAW_CONFIG_DIR/skills`.
- Workspace skills (`<workspace>/skills`) take precedence over managed skills; ClawHub installs into the workspace by default when one is configured.
- Verify with `openclaw skills list` (or the Control UI) that the skills are listed and any missing binaries or env are reported.
