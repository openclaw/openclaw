---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "ClawHub guide: public skills registry + CLI workflows"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Introducing ClawHub to new users（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Installing, searching, or publishing skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Explaining ClawHub CLI flags and sync behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "ClawHub"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ClawHub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ClawHub is the **public skill registry for OpenClaw**. It is a free service: all skills are public, open, and visible to everyone for sharing and reuse. A skill is just a folder with a `SKILL.md` file (plus supporting text files). You can browse skills in the web app or use the CLI to search, install, update, and publish skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Site: [clawhub.ai](https://clawhub.ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What ClawHub is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A public registry for OpenClaw skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A versioned store of skill bundles and metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A discovery surface for search, tags, and usage signals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. A user publishes a skill bundle (files + metadata).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. ClawHub stores the bundle, parses metadata, and assigns a version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. The registry indexes the skill for search and discovery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Users browse, download, and install skills in OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you can do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Publish new skills and new versions of existing skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discover skills by name, tags, or search.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Download skill bundles and inspect their files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Report skills that are abusive or unsafe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you are a moderator, hide, unhide, delete, or ban.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Who this is for (beginner-friendly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to add new capabilities to your OpenClaw agent, ClawHub is the easiest way to find and install skills. You do not need to know how the backend works. You can:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Search for skills by plain language.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install a skill into your workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update skills later with one command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Back up your own skills by publishing them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start (non-technical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the CLI (see next section).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Search for something you need:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `clawhub search "calendar"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Install a skill:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `clawhub install <skill-slug>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Start a new OpenClaw session so it picks up the new skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install the CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pick one:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm i -g clawhub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm add -g clawhub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it fits into OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, the CLI installs skills into `./skills` under your current working directory. If a OpenClaw workspace is configured, `clawhub` falls back to that workspace unless you override `--workdir` (or `CLAWHUB_WORKDIR`). OpenClaw loads workspace skills from `<workspace>/skills` and will pick them up in the **next** session. If you already use `~/.openclaw/skills` or bundled skills, workspace skills take precedence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For more detail on how skills are loaded, shared, and gated, see（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Skills](/tools/skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Skill system overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A skill is a versioned bundle of files that teaches OpenClaw how to perform a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
specific task. Each publish creates a new version, and the registry keeps a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
history of versions so users can audit changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A typical skill includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A `SKILL.md` file with the primary description and usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional configs, scripts, or supporting files used by the skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Metadata such as tags, summary, and install requirements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ClawHub uses metadata to power discovery and safely expose skill capabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The registry also tracks usage signals (such as stars and downloads) to improve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ranking and visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What the service provides (features)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Public browsing** of skills and their `SKILL.md` content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Search** powered by embeddings (vector search), not just keywords.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Versioning** with semver, changelogs, and tags (including `latest`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Downloads** as a zip per version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Stars and comments** for community feedback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Moderation** hooks for approvals and audits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CLI-friendly API** for automation and scripting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security and moderation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ClawHub is open by default. Anyone can upload skills, but a GitHub account must（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
be at least one week old to publish. This helps slow down abuse without blocking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
legitimate contributors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reporting and moderation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Any signed in user can report a skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Report reasons are required and recorded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each user can have up to 20 active reports at a time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills with more than 3 unique reports are auto hidden by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Moderators can view hidden skills, unhide them, delete them, or ban users.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Abusing the report feature can result in account bans.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Interested in becoming a moderator? Ask in the OpenClaw Discord and contact a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
moderator or maintainer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI commands and parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Global options (apply to all commands):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--workdir <dir>`: Working directory (default: current dir; falls back to OpenClaw workspace).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dir <dir>`: Skills directory, relative to workdir (default: `skills`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--site <url>`: Site base URL (browser login).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--registry <url>`: Registry API base URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-input`: Disable prompts (non-interactive).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-V, --cli-version`: Print CLI version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub login` (browser flow) or `clawhub login --token <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub logout`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub whoami`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`: Paste an API token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--label <label>`: Label stored for browser login tokens (default: `CLI token`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-browser`: Do not open a browser (requires `--token`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub search "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--limit <n>`: Max results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub install <slug>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--version <version>`: Install a specific version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force`: Overwrite if the folder already exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Update:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub update <slug>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub update --all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--version <version>`: Update to a specific version (single slug only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force`: Overwrite when local files do not match any published version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub list` (reads `.clawhub/lock.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Publish:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub publish <path>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--slug <slug>`: Skill slug.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--name <name>`: Display name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--version <version>`: Semver version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--changelog <text>`: Changelog text (can be empty).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tags <tags>`: Comma-separated tags (default: `latest`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delete/undelete (owner/admin only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub delete <slug> --yes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub undelete <slug> --yes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sync (scan local skills + publish new/updated):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clawhub sync`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--root <dir...>`: Extra scan roots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--all`: Upload everything without prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dry-run`: Show what would be uploaded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--bump <type>`: `patch|minor|major` for updates (default: `patch`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--changelog <text>`: Changelog for non-interactive updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tags <tags>`: Comma-separated tags (default: `latest`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--concurrency <n>`: Registry checks (default: 4).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common workflows for agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Search for skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawhub search "postgres backups"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Download new skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawhub install my-skill-pack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Update installed skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawhub update --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Back up your skills (publish or sync)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For a single skill folder:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To scan and back up many skills at once:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawhub sync --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Advanced details (technical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Versioning and tags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each publish creates a new **semver** `SkillVersion`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tags (like `latest`) point to a version; moving tags lets you roll back.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Changelogs are attached per version and can be empty when syncing or publishing updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local changes vs registry versions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Updates compare the local skill contents to registry versions using a content hash. If local files do not match any published version, the CLI asks before overwriting (or requires `--force` in non-interactive runs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sync scanning and fallback roots（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`clawhub sync` scans your current workdir first. If no skills are found, it falls back to known legacy locations (for example `~/openclaw/skills` and `~/.openclaw/skills`). This is designed to find older skill installs without extra flags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Storage and lockfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installed skills are recorded in `.clawhub/lock.json` under your workdir.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth tokens are stored in the ClawHub CLI config file (override via `CLAWHUB_CONFIG_PATH`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Telemetry (install counts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you run `clawhub sync` while logged in, the CLI sends a minimal snapshot to compute install counts. You can disable this entirely:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export CLAWHUB_DISABLE_TELEMETRY=1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CLAWHUB_SITE`: Override the site URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CLAWHUB_REGISTRY`: Override the registry API URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CLAWHUB_CONFIG_PATH`: Override where the CLI stores the token/config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CLAWHUB_WORKDIR`: Override the default workdir.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CLAWHUB_DISABLE_TELEMETRY=1`: Disable telemetry on `sync`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
