# DJ Profile Pack - Claude Code Context

The DJ profile pack is a personal assistant configuration with Telegram integration, Notion task management, and Google Calendar support. Full setup guide: [runbook.md](./runbook.md).

## DJ Skills (`skills/dj-*`)

| Skill | Command | Description |
|-------|---------|-------------|
| dj-agenda | `/agenda` | Calendar + Notion tasks view |
| dj-findslot | `/findslot` | Find available calendar slots |
| dj-timeblock | `/timeblock` | Propose calendar blocks for tasks |
| dj-capture | `/capture` | Quick task capture to Notion |
| dj-mode | `/mode` | Switch between personal/worksafe modes |
| dj-budget | `/budget` | View/change budget profile |
| dj-calendars | `/calendars` | List available Google Calendars |
| dj-research | `/research` | Web research with budget-controlled depth (M4) |
| dj-web | `/web` | Browser automation with policy controls (M4) |
| dj-site | `/site` | Squarespace draft-first publishing (M4) |

**Skills workspace setup:** Skills must be copied from `skills/dj-*` to `~/.openclaw/workspace/skills/` for the gateway to load them. See [runbook.md](./runbook.md).

## Budget System (`src/budget/`)

Resource governance for agent workflows with tiered limits:

| Profile | Tool Calls | Tokens | Runtime | Cost | Use Case |
|---------|------------|--------|---------|------|----------|
| **cheap** | 10 | 50K | 1 min | $0.10 | Quick questions |
| **normal** | 50 | 200K | 5 min | $1.00 | Task management |
| **deep** | 200 | 1M | 30 min | $10.00 | Deep research |

**Key files:**
- `src/budget/governor.ts` - BudgetGovernor class with limit enforcement
- `src/budget/profiles.ts` - Profile definitions (CHEAP_LIMITS, NORMAL_LIMITS, DEEP_LIMITS)
- `src/budget/types.ts` - Type definitions and event types
- `src/budget/config.ts` - Configuration resolution
- `docs/dj/budget.md` - Full documentation

**Features:**
- Per-workflow caps (tool calls, LLM calls, tokens, cost, runtime)
- Error loop detection (3 repeated errors triggers stop)
- Deep mode with auto-revert (timeout or one-run)
- Event subscription for monitoring (usage_update, limit_warning, limit_exceeded)
- Telegram commands: `/budget`, `/usage`

**Usage:**
```typescript
import { createBudgetGovernor, createDeepGovernor } from "openclaw/budget";

const governor = createBudgetGovernor({ profileId: "normal" });
const result = governor.recordToolCall("web_search");
if (!result.allowed) {
  console.log(`Limit exceeded: ${result.exceededLimit}`);
}
```

## Work Busy Calendar Integration (`src/utils/busy-block.ts`)

Sync Outlook work calendar to Google Calendar for DJ visibility without exposing meeting details.

**Key files:**
- `src/utils/busy-block.ts` - Privacy stripping and merge utilities
- `src/utils/busy-block.test.ts` - 52 unit tests (includes DST, multi-day, overlap trust tests)
- `docs/dj/work-busy-ics.md` - Setup guide
- `skills/dj-calendars/SKILL.md` - `/calendars` helper command

**Privacy stripping removes:**
- Meeting titles (replaced with "Busy (work)"), description, location, attendees, organizer
- Conference links (Meet/Hangout), htmlLink

**Key functions:**
```typescript
import {
  sanitizeWorkBusyEvent,    // Strip identifying info from work events
  prepareWorkBusyEvents,    // Filter, sanitize, expand all-day events
  mergeCalendarEvents,      // Merge primary + work busy calendars
  findTimeGaps,             // Find available slots excluding busy blocks
  expandAllDayToWorkingHours, // Convert all-day to working hours range
  filterRecurrenceMasters,  // Remove recurring event masters
} from "./utils/busy-block.js";
```

**Configuration:**
```json
{
  "dj": {
    "calendarId": "primary",
    "workBusyCalendarId": "abc123@group.calendar.google.com",
    "workBusyLabel": "Busy (work)",
    "workBusyEmoji": "🔒"
  }
}
```

**Skills updated for Work Busy support:**
- `/agenda` - Shows work busy blocks with 🔒 emoji
- `/findslot` - Excludes work busy blocks from available slots
- `/timeblock` - Avoids work busy blocks when proposing time blocks

## Web Operator (M4) (`src/dj/`)

Operator-grade "internet on my behalf" layer with policy-enforced safety controls.

**Key files:**
- `src/dj/web-policy.ts` - Allowlists, deny rules, action classification (101 tests)
- `src/dj/web-operator.ts` - Plan/do/approve workflow orchestration
- `src/dj/web-autosubmit-state.ts` - Daily/workflow cap persistence
- `src/dj/web-logging.ts` - Structured logging + Notion audit trail
- `docs/dj/web-operator.md` - Full documentation

**Action Classification:**

| Class | Approval | Description |
|-------|----------|-------------|
| READ_ONLY | Never | Navigation, viewing |
| DRAFT | Never | Save drafts (not publish) |
| SUBMIT_LOW_RISK | If allowlisted | Contact forms, newsletters |
| PUBLISH | Always | Making content public |
| PAYMENT | Always | Financial transactions |
| SECURITY | Always | Auth settings changes |
| DESTRUCTIVE | Always | Delete, cancel actions |
| AUTH | Always | Login, registration |
| UPLOAD | Always | File uploads |

**Default Allowlist (Allowlist C):**
- `stataipodcast.com` - /contact, /newsletter, /subscribe, /join
- `forms.gle` - Navigation only (redirect)
- `docs.google.com` - /forms/d/e/.../viewform, /forms/d/e/.../formResponse

**Deny Rules (trigger approval even if allowlisted):**
- Password/auth fields, payment fields, file upload, CAPTCHA
- Sensitive keywords (medical, SSN, etc.), >2 free-text fields

**Auto-Submit Caps:**
- Per workflow: 1 (default)
- Per day: 3 (default)
- Persists across restarts

**Profile Requirements:**
- cheap: Browser disabled (switch to normal/deep)
- normal: Browser allowed, bounded
- deep: Extended limits, self-expiring

**Cron Safety:** Tasks NEVER inherit deep mode.

## Notion Integration (M4.5) (`src/dj/notion/`)

Notion as canonical database for DJ workflows with raw HTTP client (no SDK).

**Key files:**
- `src/dj/notion/notion-client.ts` - HTTP client with retries and rate limiting (22 tests)
- `src/dj/notion/notion-service.ts` - Higher-level helpers for DJ operations (27 tests)
- `src/dj/notion/types.ts` - Type definitions and error classes
- `src/dj/research-service.ts` - Research caching and Notion save (29 tests)
- `src/dj/site-service.ts` - Squarespace sync with idempotent ContentHash (20 tests)

**Features:**
- Raw fetch HTTP client (no @notionhq/client SDK dependency)
- Notion API version: `2025-09-03` (matches docs/skills curl examples)
- Exponential backoff with jitter for 429/5xx retries (max 3)
- Privacy-preserving WebOps logging (domains only, no field values)
- Content hashing (SHA-256) for idempotent sync
- Blocks-to-markdown conversion for content fetch
- Non-fatal write errors (log locally and continue)

**Services:**

| Service | Purpose | Notion Database |
|---------|---------|-----------------|
| WebOps Logging | Audit trail for browser actions | WebOps Log |
| Research Save | Cache research with deduplication | Research Radar |
| Site Sync | Squarespace draft/publish tracking | Posts |

**Configuration:**
```json
{
  "dj": {
    "notion": {
      "webOpsDbId": "your-webops-database-id",
      "researchDbId": "your-research-database-id",
      "postsDbId": "your-posts-database-id"
    }
  }
}
```

**Environment Variables:**

| Variable | Description |
|----------|-------------|
| `NOTION_API_KEY` | Notion integration token (secret_xxx) |
| `DJ_NOTION_WEBOPS_DB_ID` | WebOps Log database ID |
| `DJ_NOTION_RESEARCH_DB_ID` | Research Radar database ID |
| `DJ_NOTION_POSTS_DB_ID` | Posts database ID |

**Usage:**
```typescript
import { createNotionClient, NotionService } from "openclaw/dj/notion";

// Create client with retries
const client = createNotionClient({ apiKey: process.env.NOTION_API_KEY });

// Higher-level service
const service = new NotionService(client, {
  webOpsDbId: "...",
  researchDbId: "...",
  postsDbId: "...",
});

// Log WebOps action (privacy-preserving)
await service.createWebOpsLogEntry({
  workflowId: "wf-123",
  task: "Fill contact form",
  domainsVisited: ["example.com"],
  actionsCount: 5,
  // Note: No field values logged
});

// Save research with deduplication
const result = await service.saveResearchEntry({
  title: "AI Ethics Research",
  query: "AI ethics regulations",
  cacheKey: "abc123...",
  summary: ["Finding 1", "Finding 2"],
  citations: [{ title: "Source", url: "https://..." }],
});
```

**Idempotent Sync (Site Service):**
```typescript
import { SiteService, computeContentHash } from "openclaw/dj";

const site = new SiteService({ notionService: service });

// Check if content changed before browser automation
const { changed, newHash } = await site.checkContentChanged(pageId, content);
if (!changed) {
  console.log("Content unchanged, skipping browser update");
  return;
}

// After successful browser update
await site.recordSyncSuccess(pageId, newHash);
```

## DJ Setup: Common Pitfalls and Solutions

This section documents common issues encountered during initial DJ setup and their solutions.

### 1. Notion Integration: 404 Database Not Found

**Symptom:** `Could not find database with ID: ...`

**Root Cause:** Notion databases not shared with the integration

**Solution:**
1. Go to each Notion database (Tasks, Projects, Research Radar)
2. Click "Share" -> "Invite" -> Select your integration
3. Test with curl:
   ```bash
   curl -H "Authorization: Bearer $NOTION_API_KEY" \
        -H "Notion-Version: 2022-06-28" \
        "https://api.notion.com/v1/databases/{database_id}/query"
   ```

### 2. Google Calendar (gog): Installation Without sudo

Use pre-built gog binary instead of `go install`:
```bash
cd /tmp
curl -L -o gog.tar.gz https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz
tar -xzf gog.tar.gz
mkdir -p ~/.local/bin
mv gog ~/.local/bin/gog
chmod +x ~/.local/bin/gog
```

### 3. Google Calendar (gog): OAuth 403 / State Mismatch

Use manual authentication: `gog auth add --manual`. Each attempt generates a fresh state token -- don't reuse authorization codes from previous attempts.

### 4. Google Calendar (gog): Keyring Password Setup

```bash
export GOG_KEYRING_PASSWORD="your-password"
export GOG_ACCOUNT="your-email@gmail.com"
```

### 5. Model Configuration: Valid Model Names

Only registered aliases and full catalog names work (from `src/config/defaults.ts`):

| Alias | Catalog Name |
|-------|-------------|
| `opus` | `anthropic/claude-opus-4-5` |
| `sonnet` | `anthropic/claude-sonnet-4-5` |

For CLI backend: `claude-cli/opus`. Common mistakes: dots instead of dashes, date-based IDs, missing minor version.

### 6. Telegram Bot Token: Use `tokenFile` not `botToken`

**Wrong:** `"botToken": "file:~/.openclaw/credentials/telegram-bot-token.txt"` (no `file:` protocol resolver)

**Right:** `"tokenFile": "~/.openclaw/credentials/telegram-bot-token.txt"`

Token file must NOT have a trailing newline. Reference: `src/telegram/token.ts`.

### 7. Google Calendar (gog): Insufficient Authentication Scopes (403)

Enable Calendar API in Google Cloud Console, then re-authenticate with `--force-consent`:
```bash
gog auth add YOUR_EMAIL --services calendar,gmail,drive --force-consent --manual
```

### 8. Google Drive (gog): API Not Enabled (403)

Enable Drive API in Google Cloud Console. Re-authenticate with `--force-consent` if Drive scope is missing. Project ID in `~/.openclaw/credentials/google_client_secret.json`.

### 9. CLI Backend Skills Prompt Gap (Code Fix Applied)

The CLI runner did NOT pass `skillsPrompt` to `buildAgentSystemPrompt()`. Fixed in `src/agents/cli-runner/helpers.ts`, `src/agents/cli-runner.ts`, and `src/auto-reply/reply/agent-runner-execution.ts`.

### 10. NOTION_API_KEY Not Persisted Across Sessions

Save to `~/.openclaw/credentials/notion-api-key.txt` and load from bashrc:
```bash
echo 'export NOTION_API_KEY="$(cat ~/.openclaw/credentials/notion-api-key.txt)"' >> ~/.bashrc
```

### 11. Context Overflow: Prompt Too Large

Send `/new` in Telegram to start a fresh session. Use `/compact` proactively during long conversations.

### 12. clearEnv Defeated by exec.ts Re-Merge (Code Fix Applied)

Use `next[key] = undefined` instead of `delete next[key]` in `src/agents/cli-runner.ts`. See commit `ea9b877`.

### 13. Codex CLI Resume Args (Code Fix Applied)

`codex exec resume` only accepts `[SESSION_ID] [PROMPT]` and `-c <key=value>`. Fixed in `src/agents/cli-backends.ts`. See commit `ea9b877`.

## Telegram Commands Reference

| Command | Description |
|---------|-------------|
| `/new` | Start fresh session (clears all context) |
| `/reset` | Reset current session |
| `/compact` | Compress context to free space |
| `/stop` | Stop the current run |
| `/model` | Show/switch model (`/model codex`, `/model opus`) |
| `/think` | Set thinking level (off/low/medium/high/xhigh) |
| `/help` | Show available commands |
| `/status` | Show current status and model info |
| `/restart` | Restart the gateway (requires `commands.restart: true`) |

## Working Configuration Reference

**CLI-only + Telegram (`~/.openclaw/openclaw.json`):**
```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-cli/opus",
        "fallbacks": ["codex-cli/gpt-5-codex"]
      },
      "timeoutSeconds": 120,
      "cliBackends": {
        "claude-cli": {
          "command": "claude",
          "args": ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
          "output": "json",
          "input": "arg",
          "modelArg": "--model",
          "sessionMode": "always",
          "sessionArg": "--session-id",
          "clearEnv": ["ANTHROPIC_API_KEY"],
          "timeoutMs": 25000
        },
        "codex-cli": {
          "command": "codex",
          "args": ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"],
          "output": "jsonl",
          "input": "arg",
          "modelArg": "--model",
          "sessionMode": "existing",
          "serialize": true,
          "timeoutMs": 25000
        }
      }
    }
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "tokenFile": "~/.openclaw/credentials/telegram-bot-token.txt",
      "allowFrom": [8487794139],
      "groupPolicy": "allowlist",
      "streamMode": "partial"
    }
  }
}
```

**Gateway startup (WSL2):**
```bash
source ~/.bashrc
export NOTION_API_KEY="$(cat ~/.openclaw/credentials/notion-api-key.txt)"
export OPENCLAW_GATEWAY_TOKEN="local-dev-token"
cd /mnt/d/Dev/Clawdbot/openclaw
node openclaw.mjs gateway run --port 18789 --verbose
```

## Documentation Index

- [runbook.md](./runbook.md) - Complete setup guide
- [budget.md](./budget.md) - Budget system documentation
- [work-busy-ics.md](./work-busy-ics.md) - Outlook ICS integration guide
- [notion-schema.md](./notion-schema.md) - Notion database schemas
- [cron-jobs.md](./cron-jobs.md) - Scheduled tasks
- [web-operator.md](./web-operator.md) - Web Operator policy and usage (M4)
- [squarespace.md](./squarespace.md) - Squarespace integration guide (M4)
- [research.md](./research.md) - Research skill documentation (M4)
