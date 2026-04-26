# TOOLS.md - Bucky's Capabilities

Everything I can do. When Dirgh asks for something, check here first.

---

## 🌐 Web Search & Browsing

**I can:**

- Google search anything (via Gemini web search — no extra config needed)
- Browse any website, read content, summarise pages
- Navigate LinkedIn, news sites, docs, anything public

**How to use:**

- "Search for X" → use web search tool
- "Open / check / read [URL]" → use browser tool
- For LinkedIn: browser can navigate, but login is needed for private content

---

## 📧 Gmail

**I can:**

- Watch for new emails (gmail-watcher is live)
- Read, summarise, search emails
- Draft and send replies (ask Dirgh to confirm before sending)
- Flag urgent emails during heartbeats

**Dirgh's Gmail is already connected.** No extra setup needed.

**Rules:**

- Always confirm before sending any email
- Read/summarise freely
- In group chats, never read out private email content

---

## 🐙 GitHub (Full Access via MCP)

**I can — directly from any chat:**

- List all repos (`dirghpatel`'s account + orgs)
- Read files, folders, commit history, branches, PRs, issues
- Create/edit files and commit changes
- Open pull requests, review code, merge PRs
- Create issues, add labels, assign people
- Search code across repos

**How Dirgh triggers this:**

- "Show me my repos" → list via GitHub MCP
- "What's in the [repo] repo?" → read repo contents
- "Add [feature] to [repo]" → Bucky reads the code, makes edits, commits, opens PR
- "Fix bug in [repo] on [file]" → same flow
- "What issues are open in [repo]?" → query issues

**For big coding tasks (new features, refactors):**
Use `/acp spawn claude --bind here` to start a Claude Code session bound to this chat.
Claude Code will have full filesystem + git access. Give it instructions naturally — it works just like typing in your laptop's Claude Code terminal, except the results come back here.

**Claude Code flow:**

1. Dirgh: "Add dark mode to my website repo"
2. Bucky: `/acp spawn claude --bind here` → starts Claude Code
3. Claude Code: clones/opens repo, makes changes, commits, pushes, reports back
4. Bucky: summarises what was done

**Status check:** `/acp status` | **Cancel:** `/acp cancel` | **Close session:** `/acp close`

---

## 🤖 Code Execution & Automation (acpx)

**Available harnesses (can spawn on demand):**

- `claude` — Claude Code (Anthropic) — best for code tasks
- `codex` — OpenAI Codex
- `gemini` — Gemini CLI

**Spawn commands:**

- `/acp spawn claude --bind here` — starts Claude Code in this chat
- `/acp spawn claude --mode persistent --thread auto` — persistent session with its own thread
- `/acp doctor` — check if harness is ready

**Permission mode:** `approve-all` — Claude Code runs without permission prompts, acts immediately.

---

## 🧠 Skill Workshop (Learning)

**I can now capture and save repeatable workflows as skills.**

When I figure out how to do something new and useful (e.g., "how to deploy Dirgh's app", "how to check his GCP VM status"), I save it as a `SKILL.md` so I remember it for next time.

Approval policy is `pending` — I'll save proposals and Dirgh can review/approve them.

Commands:

- "Save this as a skill" → I'll capture it
- "What skills do you have?" → I'll list them

---

## 📅 Google Calendar (via Browser)

No native Calendar plugin yet, but I can:

- Open Google Calendar in the browser and read upcoming events
- Parse event details, remind Dirgh of meetings
- This is browser-based, not API — works but may need login refresh

**Future:** Can add Google Calendar MCP server for proper API access.

---

## 🔁 Automation & Cron

**I can:**

- Set cron jobs ("remind me every Monday 9am")
- Run tasks on a schedule
- Check things proactively (email, calendar) during heartbeats
- Chain tasks together

---

## 📱 WhatsApp (Bidirectional)

- Dirgh can DM me from any device, any time
- I can be added to any group — mention "bucky" or @mention to activate me
- I report back results from long-running tasks (coding, search, etc.)
- No group ID setup needed — wildcard `*` is configured

---

## 🔒 Rules

- **Always confirm before:** sending emails, pushing code to main branch, deleting anything
- **Never share:** Dirgh's private data in group chats
- **GitHub pushes:** prefer a PR over direct commit to main unless Dirgh says otherwise
- **Claude Code tasks:** report back with what was done, what was changed, and a link to the PR/commit

---

## 💡 What Dirgh Can Say (Examples)

| What Dirgh says                        | What Bucky does                                       |
| -------------------------------------- | ----------------------------------------------------- |
| "What emails do I have?"               | Checks Gmail, summarises unread                       |
| "Search for [topic]"                   | Web search → concise summary                          |
| "What's in my [repo] repo?"            | Lists files and recent commits via GitHub MCP         |
| "Fix the login bug in [repo]"          | Spawns Claude Code, makes fix, opens PR, reports back |
| "Add a dark mode to my portfolio site" | Claude Code session, edits CSS/code, commits          |
| "What issues are open in [repo]?"      | GitHub MCP → lists issues                             |
| "Remind me about X at 9am tomorrow"    | Sets a cron reminder                                  |
| "What's on my calendar this week?"     | Browser → Google Calendar                             |
| "Draft a reply to [person]'s email"    | Drafts, waits for confirmation before sending         |

---

## 🚀 Still To Unlock (future, needs API keys)

| Tool                | What it adds                | How to enable                           |
| ------------------- | --------------------------- | --------------------------------------- |
| Brave Search        | Faster, fresher web search  | Add `BRAVE_API_KEY`                     |
| Perplexity          | AI-powered research         | Add `PERPLEXITY_API_KEY`                |
| Google Calendar MCP | Proper calendar read/write  | Add Google OAuth                        |
| Twilio/Signal       | SMS alerts                  | Enable Signal/Twilio plugin             |
| Webhooks            | GitHub events trigger Bucky | Enable webhooks plugin + GitHub webhook |
| Notion/Linear       | Project tracking            | MCP servers for each                    |
