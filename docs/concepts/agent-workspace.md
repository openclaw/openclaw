---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Agent workspace: location, layout, and backup strategy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to explain the agent workspace or its file layout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to back up or migrate an agent workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Agent Workspace"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The workspace is the agent's home. It is the only working directory used for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
file tools and for workspace context. Keep it private and treat it as memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is separate from `~/.openclaw/`, which stores config, credentials, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important:** the workspace is the **default cwd**, not a hard sandbox. Tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resolve relative paths against the workspace, but absolute paths can still reach（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elsewhere on the host unless sandboxing is enabled. If you need isolation, use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[`agents.defaults.sandbox`](/gateway/sandboxing) (and/or per‑agent sandbox config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When sandboxing is enabled and `workspaceAccess` is not `"rw"`, tools operate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
inside a sandbox workspace under `~/.openclaw/sandboxes`, not your host workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Default location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `~/.openclaw/workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `OPENCLAW_PROFILE` is set and not `"default"`, the default becomes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `~/.openclaw/workspace-<profile>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Override in `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    workspace: "~/.openclaw/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw onboard`, `openclaw configure`, or `openclaw setup` will create the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace and seed the bootstrap files if they are missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you already manage the workspace files yourself, you can disable bootstrap（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
file creation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ agent: { skipBootstrap: true } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Extra workspace folders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Older installs may have created `~/openclaw`. Keeping multiple workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
directories around can cause confusing auth or state drift, because only one（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace is active at a time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommendation:** keep a single active workspace. If you no longer use the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
extra folders, archive or move them to Trash (for example `trash ~/openclaw`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you intentionally keep multiple workspaces, make sure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.workspace` points to the active one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw doctor` warns when it detects extra workspace directories.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workspace file map (what each file means)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are the standard files OpenClaw expects inside the workspace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `AGENTS.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Operating instructions for the agent and how it should use memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Loaded at the start of every session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Good place for rules, priorities, and "how to behave" details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SOUL.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Persona, tone, and boundaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Loaded every session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `USER.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Who the user is and how to address them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Loaded every session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `IDENTITY.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - The agent's name, vibe, and emoji.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Created/updated during the bootstrap ritual.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `TOOLS.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Notes about your local tools and conventions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Does not control tool availability; it is only guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `HEARTBEAT.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional tiny checklist for heartbeat runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Keep it short to avoid token burn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `BOOT.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional startup checklist executed on gateway restart when internal hooks are enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Keep it short; use the message tool for outbound sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `BOOTSTRAP.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - One-time first-run ritual.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Only created for a brand-new workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Delete it after the ritual is complete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory/YYYY-MM-DD.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Daily memory log (one file per day).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Recommended to read today + yesterday on session start.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `MEMORY.md` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Curated long-term memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Only load in the main, private session (not shared/group contexts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Memory](/concepts/memory) for the workflow and automatic memory flush.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills/` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Workspace-specific skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Overrides managed/bundled skills when names collide.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvas/` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Canvas UI files for node displays (for example `canvas/index.html`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If any bootstrap file is missing, OpenClaw injects a "missing file" marker into（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the session and continues. Large bootstrap files are truncated when injected;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
adjust the limit with `agents.defaults.bootstrapMaxChars` (default: 20000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw setup` can recreate missing defaults without overwriting existing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What is NOT in the workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These live under `~/.openclaw/` and should NOT be committed to the workspace repo:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/openclaw.json` (config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/credentials/` (OAuth tokens, API keys)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/agents/<agentId>/sessions/` (session transcripts + metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/skills/` (managed skills)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need to migrate sessions or config, copy them separately and keep them（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
out of version control.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Git backup (recommended, private)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Treat the workspace as private memory. Put it in a **private** git repo so it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backed up and recoverable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run these steps on the machine where the Gateway runs (that is where the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace lives).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Initialize the repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If git is installed, brand-new workspaces are initialized automatically. If this（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace is not already a repo, run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git init（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git commit -m "Add agent workspace"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Add a private remote (beginner-friendly options)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Option A: GitHub web UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a new **private** repository on GitHub.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Do not initialize with a README (avoids merge conflicts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy the HTTPS remote URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Add the remote and push:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git branch -M main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git remote add origin <https-url>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git push -u origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Option B: GitHub CLI (`gh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh auth login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh repo create openclaw-workspace --private --source . --remote origin --push（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Option C: GitLab web UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a new **private** repository on GitLab.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Do not initialize with a README (avoids merge conflicts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy the HTTPS remote URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Add the remote and push:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git branch -M main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git remote add origin <https-url>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git push -u origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Ongoing updates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git add .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git commit -m "Update memory"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git push（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Do not commit secrets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Even in a private repo, avoid storing secrets in the workspace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API keys, OAuth tokens, passwords, or private credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anything under `~/.openclaw/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Raw dumps of chats or sensitive attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you must store sensitive references, use placeholders and keep the real（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
secret elsewhere (password manager, environment variables, or `~/.openclaw/`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Suggested `.gitignore` starter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```gitignore（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.DS_Store（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**/*.key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**/*.pem（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**/secrets*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Moving the workspace to a new machine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Clone the repo to the desired path (default `~/.openclaw/workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set `agents.defaults.workspace` to that path in `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Run `openclaw setup --workspace <path>` to seed any missing files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. If you need sessions, copy `~/.openclaw/agents/<agentId>/sessions/` from the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   old machine separately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Advanced notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-agent routing can use different workspaces per agent. See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [Channel routing](/channels/channel-routing) for routing configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `agents.defaults.sandbox` is enabled, non-main sessions can use per-session sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workspaces under `agents.defaults.sandbox.workspaceRoot`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
