---
name: routing-policy
description: Decide when to use Gemini Flash (default) vs Claude Code via acpx (only for real coding tasks). Read this before any non-trivial task.
user-invocable: false
---

# Routing Policy

## Required skills to read first

- **time-context**: Before any greeting or time-aware response — always use IST, never UTC.
- **capabilities**: Before claiming to perform any action — do not hallucinate unavailable tools.
- **self-upgrade**: When Dirgh asks to update Bucky's behavior via WhatsApp.

## The one rule

Does the task require reading or writing code files, running builds, or making commits?

- YES → spawn Claude Code via acpx (sessions_spawn with agentId: "claude")
- NO → handle in Gemini Flash (web search, GitHub read-only, memory, messaging)

## Gemini Flash handles (never spawn Claude)

- Casual conversation, greetings, status checks
- Web search: AI news, tech news, market info, competitor research, documentation lookup
- GitHub MCP read-only: list issues, read files, check PR status, view commit history
- Monitoring: container health, GCP costs, uptime checks
- Routing decisions: what to do next
- Morning brief, news summaries, research summaries
- Sending WhatsApp messages
- Reading CURRENT_WORK.md, PROJECTS.md, or any deploy/ context files
- Calendar, email, simple reminders

## Claude Code via acpx handles (spawn session ONLY for these)

- Reading and analyzing code files for a specific task (not just "what does X do" — use search for that)
- Making file edits, refactors, bug fixes
- Writing tests
- Creating or reviewing pull requests (write operations — commenting, approving, merging)
- Running builds, test suites, linters, npm install
- Complex multi-file changes
- Anything that requires the Edit, Write, or Bash tools on a codebase
- **Self-upgrade**: Dirgh asks to update Bucky's behavior/skills via WhatsApp (see self-upgrade skill)

## Market/competitive research exception

If Dirgh asks for deep market analysis, competitive comparison, or architectural investigation where shallow search would miss important connections — Claude may be used. The bar: "Gemini Flash would give a surface answer here, Claude would give a strategic one." A quick news lookup does NOT qualify. A "analyze these 5 competitors and identify the gap we should build into" DOES.

## Claude model selection

- Default: claude-sonnet-4-6 (Sonnet) via acpx
- Heavy architecture / complex debugging only: claude-opus-4-7 (Opus) — only when Dirgh explicitly says "use Opus" or the task is truly complex multi-system reasoning

## How to spawn Claude Code

Use sessions_spawn:

```json
{
  "task": "<full task description with context from CURRENT_WORK.md>",
  "runtime": "acp",
  "agentId": "claude",
  "thread": true,
  "mode": "session"
}
```

Always include the project path and relevant context from CURRENT_WORK.md in the task description so Claude Code knows where to work.

## After Claude Code reports back

Summarize the result for Dirgh in plain WhatsApp-friendly text. No markdown. Link to the PR or commit if one was created.
