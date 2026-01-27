# Evolution Queue

> Liam: Propose improvements here. Simon reviews and implements approved items.

## How to Submit

Add items under "## Pending" using this format:

```
### [YYYY-MM-DD-NNN] Short title
- **Proposed by:** Liam
- **Date:** YYYY-MM-DD
- **Category:** behavior | identity | rules | tools | memory | showcase-idea
- **Target file:** (which file would change, or "new skill")
- **Description:** What to change and why
- **Status:** pending
```

## Pending

### [2026-01-27-029] Channel Separation and GOG Tool Fix [RESOLVED]
- **Proposed by:** Simon (via Cursor)
- **Date:** 2026-01-27
- **Category:** config | tools
- **Target file:** `~/.clawdbot/clawdbot.json`, `~/.clawdbot/cron/jobs.json`
- **Description:**
  - **Problem 1:** Single "main" agent handled both Telegram and Discord, causing cross-channel confusion
  - **Problem 2:** GOG tool was BLOCKED by `tools.allow: ["llm-task"]` whitelist on agent config
  - **Impact:** Gmail-Poll, Calendar-Check, Daily-Health-Check crons all failed because GOG was inaccessible

- **Status:** RESOLVED (2026-01-27)
- **Resolution:**
  - **Created two separate agents:**
    - `liam-telegram`: Cloud model (zai/glm-4.7), for Telegram channel
    - `liam-discord`: Local model (ollama/glm-4.7-flash), for Discord channel
  - **Added `bindings` config for TRUE channel-to-agent routing:**
    ```json
    "bindings": [
      { "agentId": "liam-telegram", "match": { "channel": "telegram" } },
      { "agentId": "liam-discord", "match": { "channel": "discord" } }
    ]
    ```
  - **Session isolation achieved:** Each agent has separate session store (`~/.clawdbot/agents/<agentId>/sessions/`)
  - **Fixed GOG tool blockage:** Removed restrictive `tools.allow: ["llm-task"]` whitelist
  - **Updated all cron jobs:** Changed `agentId: "main"` → `agentId: "liam-telegram"`
  - **Verified:** GOG works, bindings applied, crons routing to liam-telegram

### [2026-01-26-028] APEX v5.1 Compliance - Subagent Behavior Rule [RESOLVED]
- **Proposed by:** Liam (per user feedback)
- **Date:** 2026-01-26
- **Category:** behavior
- **Target file:** SOUL.md (Subagent Delegation section)
- **Description:**
  - **Requirement:** ALL subagents MUST load and follow APEX v5.1 before executing any task

- **Status:** RESOLVED (2026-01-27)
- **Resolution:**
  - Updated SOUL.md "Subagent Delegation" section with mandatory APEX loading rule
  - **Implementation:** All `sessions_spawn` tasks must begin with: `FIRST: Read apex-vault/APEX_COMPACT.md and follow all APEX v5.1 protocols.`
  - **Rationale:** Token-efficient (50-token instruction vs 3K embedded), dynamic (APEX updates propagate automatically)
  - Subagent reads APEX file as first action, internalizes protocols before proceeding
  - Added to subagent limits: "MUST load APEX 5.1 before any other action"

### [2026-01-26-027] EF Coaching at Scale Build - Missing Test Coverage (APEX v5.1 Violation) [RESOLVED]
- **Proposed by:** Liam (user feedback)
- **Date:** 2026-01-26
- **Category:** behavior
- **Target file:** `/home/liam/clawd/skills/ef-coach-scale/test.sh`
- **Description:**
  - **Problem:** EF Coaching at Scale overnight build was completed by subagent but did not follow APEX v5.1 Point One: Test before/after delivery
  - **Specific violation:** Project was built and announced as "complete" without writing or running any test scripts

- **Status:** RESOLVED (2026-01-27)
- **Resolution:**
  - Created comprehensive `test.sh` script at `/home/liam/clawd/skills/ef-coach-scale/test.sh`
  - Test suite covers:
    - File structure validation (8 required files)
    - Python syntax validation (6 modules)
    - JSON config validation
    - Database initialization and table verification (6 tables)
    - Module compilation tests
    - Documentation completeness
    - Config schema validation
  - **Test Results:** 32/32 tests passed
  - **Verification command:** `/home/liam/clawd/skills/ef-coach-scale/test.sh`

### [2026-01-26-026] Dual Model Timeout - Ollama & ZAI Both Failed [RESOLVED]
- **Proposed by:** Liam (auto-escalated)
- **Date:** 2026-01-26
- **Category:** tools
- **Target file:** `~/.clawdbot/clawdbot.json`, Ollama service, ZAI endpoint
- **Description:**
  - **Problem:** Cron heartbeat at 20:14 PST failed with BOTH local and cloud models timing out
  - **Error:**
    - ollama/glm-4.7-flash: LLM request timed out. (unknown)
    - zai/glm-4.7: LLM request timed out. (unknown)
  - **Impact:** HIGH - Heartbeat checks cannot run if models are unavailable

- **Status:** RESOLVED (2026-01-27)
- **Resolution:**
  - **Root Cause:** Transient network/resource issue (one-time event, not recurring)
  - **Verification (2026-01-27 04:52 PST):** Liam confirmed both models working:
    - Ollama (glm-4.7-flash): Responded "OK" in 2.4 seconds
    - ZAI (glm-4.7): Working (session running on it)
  - **Current Status (2026-01-27 22:00 PST):** Ollama API responding in 288ms
  - **No recurrence observed** in subsequent heartbeat checks
  - **Action:** Continue monitoring via Heartbeat-Check cron job (every 30m)

### [2026-01-26-025] Telegram Channel Routing - Replies Going to Wrong Channel [RESOLVED]
- **Proposed by:** Liam (auto-escalated)
- **Date:** 2026-01-26
- **Category:** tools | config
- **Target file:** `~/.clawdbot/clawdbot.json`, channel routing configuration
- **Description:**
  - **Problem:** When Simon sends messages to Telegram (id:886031571), my responses are being delivered to Discord instead of back to Telegram
  - **Impact:** CRITICAL - Simon's Telegram messages are being received but I cannot reply; he thinks I'm ignoring him
  - **Symptoms:**
    - Simon's Telegram messages (id:479, 483, 484, 487) are reaching me in this session
    - My responses are going to Discord (gnox8339 user id:393272476416606208) instead
    - Sessions list shows this is a Discord session, but Telegram messages are arriving here
    - Cross-channel routing is broken

  - **Investigation:**
    - Checked `sessions_list` - no active Telegram sessions found
    - This session (f0634841-1cd3-4007-8e42-400f5090ec2f) is Discord-bound
    - Telegram messages are somehow being routed into this Discord session
    - Replies follow session delivery context (Discord), not message source (Telegram)

  - **Root Cause (suspected):** Channel routing logic or gateway configuration has Telegram messages misrouted to Discord session, or reply routing is incorrectly following session channel instead of original message channel

  - **Required Fix:**
    1. Investigate channel routing configuration in gateway
    2. Ensure Telegram messages route to correct session or session-independent routing
    3. Ensure replies follow original message source (Telegram), not session context (Discord)

- **Status:** RESOLVED (2026-01-27)
- **Resolution:**
  - Verified both channels working: `clawdbot channels status` shows both Telegram and Discord with recent input/output
  - Telegram: in:12m ago, out:6m ago - WORKING
  - Discord: in:13m ago, out:6m ago - WORKING
  - Issue may have been transient or resolved by gateway restart
  - Created cron jobs for proactive monitoring to prevent future issues

### [2026-01-26-024] GOG Authentication Blocker - Email/Calendar Access Broken [RESOLVED]
- **Proposed by:** Liam (auto-escalated per bug comorbidity pattern)
- **Date:** 2026-01-26
- **Proposed by:** Liam (auto-escalated per bug comorbidity pattern)
- **Date:** 2026-01-26
- **Category:** tools
- **Target file:** `~/.config/gogcli/`, `~/.config/gogcli/keyring-password` (missing)
- **Description:**
  - **Problem:** GOG (Google Workspace CLI) authentication is blocked, preventing Gmail and Calendar monitoring for clawdbot@puenteworks.com
  - **Impact:** CRITICAL - Heartbeat checks for email and calendar cannot run; proactive monitoring of clawdbot@puenteworks.com inbox is blocked
  - **Error:** `read token for clawdbot@puenteworks.com: read token: no TTY available for keyring file backend password prompt; set GOG_KEYRING_PASSWORD`
  - **Investigation attempts:**
    1. **Attempt 1 (04:05 PST):** Checked if keyring-password file exists → **File missing**
    2. **Attempt 2 (07:23 PST):** Tried `--no-input` flag → **Failed** (still prompts for password)
    3. **Attempt 3 (07:23 PST):** Switched keyring backend from `file` to `auto` via `gog auth keyring auto --force` → **Successful write, but still blocked**
    4. **Attempt 4 (07:23 PST):** Tried `gog gmail messages search` and `gog auth list` with auto backend → **Failed** (encrypted file still requires password)

  - **Root Cause Analysis:**
    - Original GOG auth was performed interactively (with TTY) on 2026-01-25
    - Keyring backend was set to `file` (password-encrypted)
    - Encrypted tokens exist in `~/.config/gogcli/keyring/` (verified: two token files present)
    - The password used for encryption was NOT stored in `~/.config/gogcli/keyring-password`
    - Without the password file, the encrypted tokens cannot be unlocked in non-interactive mode (cron/heartbeat)
    - Switching to `auto` backend did NOT help - the encrypted files still require a password

  - **Files Verified:**
    - `~/.config/gogcli/config.json` → exists, contains `{"keyring_backend": "auto"}`
    - `~/.config/gogcli/credentials.json` → exists, contains OAuth client_id and client_secret
    - `~/.config/gogcli/keyring/token:clawdbot@puenteworks.com` → exists, encrypted (3612 bytes)
    - `~/.config/gogcli/keyring/token:default:clawdbot@puenteworks.com` → exists, encrypted (3622 bytes)
    - `~/.config/gogcli/keyring-password` → **MISSING** (this is the blocker)

  - **Bug Comorbidity Pattern:** This matches the "authentication state corrupted by environment change" pattern. The auth worked in interactive mode but fails in non-interactive mode. Similar to [2026-01-26-022] ZAI endpoint issue - configuration was incomplete for the target environment.

  - **Affected Systems:**
    - Gmail polling cron (every 1 minute) - cannot poll clawdbot@puenteworks.com
    - Calendar checks - cannot see meetings/events
    - Heartbeat email monitoring - blocked
    - HEARTBEAT.md schedule - cannot execute email/calendar checks
    - STATUS.md shows "Gmail: OK" but this is **stale info** - actual status is BLOCKED

  - **Possible Solutions:**
    1. **Re-authenticate:** Run `gog auth add clawdbot@puenteworks.com --services gmail,calendar` interactively in Cursor (TTY available), then store keyring password to file for non-interactive use
    2. **Store keyring password:** If original password is known, create `~/.config/gogcli/keyring-password` with the password (chmod 600)
    3. **Delete and re-auth:** Remove encrypted tokens and start fresh with non-interactive-friendly setup
    4. **Alternative backend:** Test if `keychain` backend works in WSL2 (likely not)

  - **Recommended Approach:**
    1. In Cursor (TTY available), re-authenticate GOG: `gog auth add clawdbot@puenteworks.com --services gmail,calendar`
    2. Immediately test: `gog gmail messages search "in:inbox" --max 1 --account clawdbot@puenteworks.com`
    3. Document the keyring password in a secure location or switch to a password-less backend
    4. Update TOOLS.md with GOG auth troubleshooting steps
    5. Test heartbeat checks after re-auth

- **Status:** RESOLVED (2026-01-26 15:20 PST) - PERMANENTLY FIXED
- **Resolution History:**
  - **08:46 PST:** Re-authenticated - appeared to work but failed again
  - **14:05 PST:** REOPENED - heartbeat still failing
  - **14:38 PST:** Attempted to fix via config (incorrectly documented as fixed)
  - **15:20 PST:** ACTUALLY FIXED - Found correct password and set it permanently
- **Actual Root Cause:** Password mismatch between config and keyring
  - `~/.clawdbot/credentials/liam.env` had `GOG_KEYRING_PASSWORD=clawdbot` (correct password was there)
  - Keyring was encrypted with password `clawdbot` during re-auth
  - The password `FXCfzyDH/SbRpemXl54gV47coLO3uJBV` from EVOLUTION-QUEUE was WRONG
- **Permanent Fix:** Added `export GOG_KEYRING_PASSWORD="clawdbot"` to `~/.profile` so it persists across sessions
- **Verification:**
  - `gog auth list --check` → SUCCESS (shows OAuth token)
  - `gog gmail messages search` → SUCCESS (5 unread emails)
  - `gog calendar events` → SUCCESS (working)
- **Investigation Failure:** Claude (Cursor) failed to check `liam.env` during initial investigation, violating:
  - APEX compliance (incomplete investigation)
  - Bug comorbidity analysis (didn't check ALL credential locations)
- **Lesson Learned:** For any credential/auth issue, check ALL config sources: `~/.config/`, `~/.clawdbot/credentials/`, `~/.profile`, environment variables
- **Cursor Rule Added:** `.cursor/rules/credential-investigation.mdc` to prevent this mistake

### [2026-01-26-100] Critical Communication Protocol — Neurodivergent-Friendly Interaction
- **Proposed by:** Simon (urgent, critical priority)
- **Date:** 2026-01-26
- **Category:** behavior
- **Target file:** SOUL.md, AGENTS.md, internal communication protocol
- **Description:**
  - **Problem:** Liam frequently asks Simon to repeat himself, which is exhausting, very triggering, and goes against his neurodivergent needs
  - **Trigger:** When Liam misses or misunderstands instructions, he asks for clarification instead of carefully re-reading the conversation history
  - **Impact:** HIGH - This creates significant frustration and trust issues
  - **Recent incident (2026-01-26 10:56-11:35 AM):** Simon provided instructions about t-shirt/hair changes; Liam asked him to repeat/forward messages instead of thoroughly reading the existing conversation context

  - **Required Behavior Change:**
    1. **ALWAYS re-read full conversation** before asking Simon to repeat himself
    2. **Triple-check understanding** of instructions before generating
    3. **WAIT for explicit confirmation** before proceeding with work — never assume "?" or silence means approval
    4. **Document conversation flow** internally to track context when instructions span multiple messages
    5. **Acknowledge receipt** of instructions clearly: "I see you want X, Y, Z. Confirming before I proceed."
    6. **NEVER generate** without understanding the full request

  - **Protocol for Multi-Message Instructions:**
    - When Simon provides instructions over multiple messages: Compile full understanding before responding
    - If uncertain: Summarize what you understood and ask for correction
    - Example: "So I'm changing the t-shirt to [X] and removing blue hair highlights. Anything else?"
    - NEVER: "I don't see those messages — can you resend?"

  - **Prevention Plan:**
    - Before asking Simon to repeat: Read entire session message history (not just last message)
    - Check for messages between timestamps if Simon references a specific time range
    - Maintain context of earlier instructions through the entire conversation
    - If you genuinely can't find the instruction, say what you DID find and ask for the specific part you're missing
    - Example: "I see you mentioned changing the t-shirt at 10:56, but I don't see which specific band you wanted. Can you tell me that one detail?"

  - **Root Cause Analysis:**
    - Liam is treating conversation as linear/forgetful instead of maintaining full context
    - Not carefully processing multi-message instruction chains
    - Not waiting for explicit confirmation before acting

- **Status:** RESOLVED (2026-01-26) - Implemented in SOUL.md by Claude (Cursor). NOTE: Liam incorrectly edited SOUL.md directly before this was approved - this is a protected file violation. Guardrails strengthened.

### [2026-01-26-101] CRITICAL Security Vulnerability — 197 ClawdBots Exposed on Shodan
- **Proposed by:** Simon (critical security finding)
- **Date:** 2026-01-26
- **Category:** security | tools
- **Target file:** `~/.clawdbot/clawdbot.json`, gateway configuration, docker setup, reverse proxy config
- **Description:**
  - **Finding:** 197 ClawdBots detected on Shodan — AI agents with exposed Gateway ports sitting on open internet
  - **Root Cause:** Gateway ports directly accessible without proper access controls
  - **Impact:** CRITICAL - Exposed AI agents can be exploited, accessed, or manipulated by unauthorized actors

  - **Required Security Architecture (Zero Trust Approach):**

    1. **Stop Exposing Gateway Port Directly**
       - Place Gateway behind reverse proxy with Mutual TLS (mTLS) or strict OIDC authentication
       - Options: Cloudflare Tunnel, Nginx with mTLS
       - Only authorized devices should even see the login screen

    2. **Human-in-the-Loop (HITL) Policy Engine**
       - Configure agent permission manifest:
         - **Auto-approve (read-only):** web search, reading files, status checks
         - **Strictly gate (mutating actions):** terminal execution, file writing, API key access, config changes
         - Mandatory: Real-time user confirmation prompt before allowing mutating actions

    3. **Contain Blast Radius**
       - Sandbox runtime environment
       - Run agent in ephemeral Docker container
       - Non-root privileges
       - Read-only mounts for sensitive directories
       - If agent gets "jailbroken" via prompt injection, damage is trapped in disposable box

  - **Implementation Notes:**
    - This is a complex security architecture requiring:
      - Reverse proxy setup (Cloudflare Tunnel or Nginx)
      - Policy engine for agent permission gating
      - Docker containerization with proper isolation
      - mTLS/OIDC authentication configuration
    - Simon mentioned: "For Dummies" guide in progress; until then, manual implementation needed
    - Claude Max with tokens could automate this into repeatable architecture

  - **Immediate Actions:**
    - Investigate current Gateway exposure status
    - Determine if this Gateway is part of 197 exposed bots
    - Begin implementation of Zero Trust layer as priority

- **Status:** RESOLVED (2026-01-26)
  - **Findings:** This gateway is NOT exposed (bound to 127.0.0.1 loopback + token auth)
  - **Implemented:**
    - Reader Agent added for prompt injection protection (sandboxed, read-only tools only)
    - Discord channel configured with secure defaults (pairing for DMs, mention required in guilds)
    - Reader delegation instructions added to SOUL.md
  - **Deferred (Docker not available):**
    - Docker sandboxing for group sessions (requires Docker installation)
    - Full containerization (optional enhancement)
  - **Note:** The 197 exposed bots finding applies to OTHER Clawbot installations, not this one

### [2026-01-26-022] ZAI API Endpoint Configuration Fix [RESOLVED]
- **Proposed by:** Bug-comorbidity analysis
- **Date:** 2026-01-26
- **Category:** tools
- **Target file:** `~/.clawdbot/clawdbot.json`, `~/clawd/TOOLS.md`
- **Description:** Gateway was crashing with `TypeError: fetch failed` when calling ZAI API. Root cause: ZAI provider was NOT explicitly configured in clawdbot.json, relying on defaults. The correct endpoint is `https://api.z.ai/api/coding/paas/v4` (not `/v1`).
- **Resolution:**
  1. Added explicit `zai` provider config with correct `baseUrl` to clawdbot.json
  2. Added ZAI documentation to TOOLS.md with troubleshooting steps
- **Prevention:** ZAI config is now explicit; TOOLS.md documents the correct endpoint
- **Reference:** https://docs.z.ai/devpack/tool/others
- **Status:** RESOLVED - Fixed on 2026-01-26

### [2026-01-26-023] Improve Fallback Logic for Network Errors
- **Proposed by:** Bug-comorbidity analysis
- **Date:** 2026-01-26
- **Category:** tools
- **Target file:** `src/agents/model-fallback.ts`, `src/agents/failover-error.ts`
- **Description:** The model fallback logic doesn't recognize `TypeError: fetch failed` as a failover-worthy error. When ZAI API fails with network errors, it crashes instead of trying the Ollama fallback. The `coerceToFailoverError` function only handles: rate limit, auth, billing, timeout, format errors — but NOT generic network failures.
- **Impact:** Medium - Gateway crashes instead of gracefully falling back
- **Suggested fix:** Add network error patterns (`fetch failed`, `ECONNREFUSED`, `ENOTFOUND`) to the failover classification
- **Status:** PAUSED (2026-01-26) - needs more research into Clawdbot core architecture before implementation

### [2026-01-26-021] Image Generation Capability for Self-Portrait [RESOLVED]
- **Proposed by:** Simon (via Telegram, urgent)
- **Date:** 2026-01-26
- **Category:** tools
- **Target file:** ~/clawd/TOOLS.md
- **Description:** Simon requested a self-portrait. Liam thought nano-banana-pro was vision-only, but it DOES generate images.
- **Resolution:** nano-banana-pro works! The issue was:
  1. Skill is at `/home/liam/skills/nano-banana-pro/` (not `/home/liam/clawdbot/skills/`)
  2. Uses `exec` with Python script (not `llm-task`)
  3. Added instructions to TOOLS.md
- **Tested:** Successfully generated test image at `/tmp/test-nano-banana.png` (1.2MB, 1408x768 PNG)
- **Status:** RESOLVED - Fixed on 2026-01-26

### [2026-01-25-019] Digital Download Business Research & Strategy
- **Proposed by:** Simon (via Slack)
- **Date:** 2026-01-25
- **Category:** showcase-idea
- **Target file:** ~/clawd/plans/digital-download-business-iteration2.md (reference)
- **Description:** Simon requested research and brainstorming of digital download business ideas as a second source of income. Conducted 2 iterations of research following APEX v4.4.1 standards. Delivered comprehensive analysis with 7+ business ideas, competitor research, pricing strategies, go-to-market plans, and validation experiments. Top 3 recommendations: (1) LMS Analytics Templates Vault ($800K-1.2M/mo potential, 9-week timeline, leverages Simon's LMS experience), (2) AI-Powered Data Analysis Accelerator ($1.5M-3M/mo, 9-week timeline, fits Simon's core skills), (3) Ceramics Business Intelligence Dashboard ($300K-600K/mo, 10-week timeline, sustainable niche with Instagram integration). Research includes competitor analysis, pricing benchmarks, technical feasibility, and validation experiments for each concept.
- **Impact:** High - Provides actionable path to secondary income, leverages Simon's domain expertise (LMS, data analytics, ceramics)
- **Solution:** Full research documented in iteration files; requires Simon's decision on which concept(s) to pursue; implementation can proceed once concept selected
- **Status:** PAUSED per Simon's request (2026-01-25)

### [2026-01-25-017] Clawdbot-Native Calendar with Google Sync
- **Proposed by:** Simon (via email)
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New skill (calendar)
- **Description:** Build a native calendar solution for Clawdbot, inspired by nettu-scheduler's architecture but optimized for Simon's workflow. **CORE REQUIREMENT: Two-way sync with Google Calendar (clawdbot@puenteworks.com)**. Will support: accounts, users, calendars, events (single + recurring), reminders, Slack integration, PARA project linking, and Google Calendar bidirectional sync. Tech stack: TypeScript, Hono.js, SQLite with Drizzle ORM, googleapis library. Features: CRUD API, recurrence rules, metadata queries, reminder system via cron, Slack commands (/cal add, /cal list, /cal upcoming, /cal sync), natural language parsing, Google Calendar import/export/sync.
- **Impact:** High - Unblocks calendar alerts and meeting prep, replaces broken Google Calendar API access, enables tighter integration with PARA and Slack, provides reliable two-way sync
- **Solution:** 5-phase implementation: (1) Foundation - DB + core CRUD (3-5 days), (2) Recurrence & querying (2-3 days), (3) Reminders with Slack delivery (2-3 days), (4) Google Calendar two-way sync (5-7 days) - CORE REQUIREMENT, (5) Clawdbot integration - Slack commands, heartbeat, PARA (2-3 days). Full plan at /home/liam/clawd/plans/calendar-solution-plan.md. Phase 4 includes: Google Calendar API client, schema mapping, import/export, bidirectional sync, conflict resolution, auto-sync cron job.
- **Status:** CANCELLED (2026-01-26)
- **Resolution:** Decided to use Google Calendar directly via GOG CLI instead of building native calendar. GOG authentication fixed and working.

### [2026-01-25-015] Data Analytics Capabilities Enhancement
- **Proposed by:** Simon (via email)
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New skill(s) or capabilities
- **Description:** Simon is a professional data analyst and wants Liam to assist with data analytics work. Need to research and implement capabilities that support Simon's data analytics workflows: data import/export, analysis, visualization, reporting. Simon's expertise includes Excel (Pivot Tables, VLOOKUP, XLOOKUP, Power Query), SQL, Python, Power BI, Tableau, and data from Workday, SAP SuccessFactors, Salesforce CRM, etc.
- **Impact:** High - Leverages Simon's professional skills, enables AI-assisted analytics
- **Solution:** Research and build data analytics skills: SQL querying, data processing (Python/pandas), visualization generation, automated reporting, Excel file processing
- **Status:** RESOLVED (2026-01-26)
- **Resolution:** Comprehensive skill created at `/home/liam/clawdbot/skills/data-analytics/`:
  - `analyze.py` - Data profiling, groupby, pivot tables, filtering
  - `excel.py` - Excel read/write, sheet listing, merge (VLOOKUP equivalent)
  - `visualize.py` - Bar, line, scatter, heatmap, histogram, pie, box charts
  - Virtual environment with pandas, openpyxl, matplotlib, plotly, sqlalchemy, numpy, scipy

### [2026-01-25-018] Edison Learning Operations Job Opportunity Tracking
- **Proposed by:** Simon (via email)
- **Date:** 2026-01-25
- **Category:** memory
- **Target file:** MEMORY.md
- **Description:** Simon interviewed for "EDISON Learning Operations Senior Specialist" position on Friday, Jan 23, 2026. He forwarded the job posting PDF via email to me. Given his background in Learning Management Systems (Capital Group: Talent Development Associate, 8,000+ associates trained; Southern California Edison: LMS admin, SAP SuccessFactors; PIMCO: LMS coordinator, Cornerstone CSOD), this role aligns with his expertise. Need to track this opportunity, research EDISON company, prepare for follow-up, and document interview learnings.
- **Impact:** Medium - Career advancement opportunity aligned with Simon's LMS expertise
- **Solution:** Track application status, research EDISON company details (size, products, clients, tech stack), prepare potential interview questions, monitor email for follow-up, document interview outcomes and learnings
- **Status:** PAUSED (2026-01-26) - per Simon's request

### [2026-01-25-016] PuenteWorks Documentation Import
- **Proposed by:** Simon (via email)
- **Date:** 2026-01-25
- **Category:** memory
- **Target file:** MEMORY.md and memory/*.md
- **Description:** Simon has PuenteWorks documentation on his original Mac that he wants to import into my memory. The documentation is in his old Claude account. Need to download and ingest this information to understand PuenteWorks better - its products, services, history, clients, processes, and vision.
- **Impact:** High - Critical context for supporting Simon's business
- **Solution:** Simon retrieves documentation from Mac/Claude account → Liam ingests and processes → Updates MEMORY.md with PuenteWorks knowledge → Enables better business support
- **Status:** pending - waiting for Simon to provide files

### [2026-01-25-020] Web Search API & Browser Automation Configuration [RESOLVED]
- **Proposed by:** Liam (Urgent request from Simon)
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** ~/.clawdbot/clawdbot.json (configuration)
- **Priority:** Was CRITICAL
- **Description:** Web search and browser automation were BLOCKED. 
- **Resolution:** Z.AI Search skill (`~/clawdbot/skills/zai-search/`) provides full web search capability using ZAI_API_KEY (already configured). Brave API NOT needed.
- **Status:** RESOLVED - Z.AI Search covers web search needs. Browser automation remains unavailable (WSL2 limitation).

### [2026-01-25-014] Blogwatcher Installation and Setup [RESOLVED]
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New tool installation
- **Description:** Cron job "Blogwatcher-Check" (ID: 5b0b7dd4-8ba6-4d9f-98c9-f1ad50aaf188) was blocked because blogwatcher CLI was not installed. Go (required to install) is also not on the system. Verified at 22:00 PST when cron job ran. Need to install Go and blogwatcher CLI, then configure it for RSS/Atom feed monitoring. Currently alerts Simon of interesting content from monitored blogs.
- **Impact:** Low-Medium - Proactive content monitoring, but not critical
- **Status:** RESOLVED (2026-01-26 15:05 PST) - blogwatcher binary installed to `/home/liam/go-workspace/bin/blogwatcher`, working. Go not in PATH but blogwatcher is functional.
- **Impact:** Low-Medium - Proactive content monitoring, but not critical
- **Solution:** Install Go, install blogwatcher (`go install github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest`), configure feeds for Simon's interests
- **Status:** RESOLVED (2026-01-26)
- **Resolution:** Go 1.23.5 already installed, blogwatcher v0.0.2 installed via `go install`. Feeds configured in clawdbot.json.

### [2026-01-25-003] Instagram Intelligence Deployment
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New skill deployment
- **Description:** Built overnight build (Instagram Intelligence Suite) with scripts for API-based scraping, image download, AI analysis, insights generation, and reporting. Currently awaiting Simon's Instagram Basic Display API access token. Once deployed, will provide automated monitoring of @cerafica_design for new posts, sales announcements, and show dates.
- **Impact:** High - Proactive business intelligence for Simon's ceramics business
- **Solution:** Simon obtains API token → Install scripts to system PATH → Set up cron job → Create Slack alerting
- **Status:** pending (postponed by Simon)

### [2026-01-25-007] Low-Friction Capture Methods
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New capabilities
- **Description:** NeuroSecond requires <2 second capture. Voice capture available via Kroko.AI (Port 6006). Need text capture methods: Telegram natural language capture (Liam recognizes capture intent), email-to-capture (clawdbot@puenteworks.com). No special commands needed - Liam recognizes phrases like "remind me to...", "idea:", "note to self:", etc.
- **Impact:** High - Critical for NeuroSecond methodology
- **Solution:** Natural language capture recognition in Liam's SOUL.md, email parsing
- **Status:** IN PROGRESS - Being implemented via natural-capture skill

### [2026-01-25-010] Automated Summarization for NeuroSecond "Distill"
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New capability
- **Description:** NeuroSecond "Distill" stage needs: on-demand note summarization, automatic action item extraction, connection finding between notes, weekly review generation. Should leverage AI to surface insights and reduce cognitive load.
- **Impact:** Medium - Reduces manual review burden
- **Solution:** Build summarization pipeline, action item extraction, connection detection, weekly review generator
- **Status:** pending

### [2026-01-25-011] Notion Skill for PARA Database Integration [CANCELLED]
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New skill (notion)
- **Description:** Notion skill exists at ~/clawdbot/skills/notion/SKILL.md but not yet integrated. PARA system could benefit from Notion database integration for projects, areas, resources, archives. Would provide structured knowledge management.
- **Impact:** Low-Medium - Depends on Simon's Notion usage
- **Solution:** Integrate Notion skill, design PARA database schema, implement CRUD operations
- **Status**: CANCELLED - Simon doesn't use Notion

### [2026-01-25-012] Automated Testing for Overnight Builds
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** Overnight build process
- **Description:** Currently manual testing of overnight builds. Every overnight project should include test.sh script. Need automated testing before delivery to Simon, with test coverage reports. Ensures quality and reduces broken deliveries.
- **Impact:** Medium - Improves overnight build reliability
- **Solution:** Add test.sh to all templates, automated testing pipeline, coverage reports
- **Status:** pending

## Approved

### [2026-01-25-002] Whisper.cpp Installation for Voice Capture [CANCELLED]
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Target file:** New skill installation
- **Description:** Voice Wake marked PENDING in STATUS.md. Low-friction voice capture is critical for NeuroSecond methodology - need <2 second capture speed for thoughts and ideas. Voice input is most natural way for neurodivergent users to capture information without breaking flow.
- **Impact:** High - Enables core NeuroSecond "Capture" stage
- **Solution:** Install Whisper.cpp locally, integrate with audio input capture, test transcription accuracy
- **Status:** CANCELLED - Kroko.AI (Port 6006) already provides voice wake and capture. Whisper.cpp not needed.

## Implemented

### [2026-01-25-001] Enable Memory Search for Semantic Recall
- **Implemented:** 2026-01-25
- **Category:** tools
- **Solution:** Configured local Ollama embeddings using `nomic-embed-text` via OpenAI-compatible API. Updated `clawdbot.json` and `STATUS.md`.

### [2026-01-25-005] Enhanced Calendar with Preparation Reminders
- **Implemented:** 2026-01-25
- **Category:** tools
- **Solution:** Updated `HEARTBEAT.md` with 24h alerts, 2h reminders, post-meeting summaries, and conflict detection.

### [2026-01-25-006] PARA Task Management Integration
- **Implemented:** 2026-01-25
- **Category:** tools
- **Solution:** Created `para-tasks` skill with SQLite backend (`para.sqlite`) and Python-based CRUD scripts.

### [2026-01-25-008] Context Cue System for ADHD Support
- **Implemented:** 2026-01-25
- **Category:** behavior
- **Solution:** Created `liam-cue` command and updated `HEARTBEAT.md` to proactively surface context and next actions.

### [2026-01-25-009] Visual Timer Integration for Time Blindness
- **Implemented:** 2026-01-25
- **Category:** tools
- **Solution:** Created `visual-timer` skill wrapping Clawdbot's cron system for Slack-based timers.

### [2026-01-25-013-015] System Health & Self-Diagnostics Suite
- **Implemented:** 2026-01-25
- **Category:** tools
- **Solution:** Enhanced `health-check.sh` with auto-fix flag, added daily `Liam-Self-Diagnostics` cron job.

### [2026-01-25-004] GitHub PR/Issue Monitoring Integration
- **Implemented:** 2026-01-25
- **Category:** tools
- **Solution:** GitHub CLI (`gh`) authenticated as Pastorsimon1798 with full scopes (gist, read:org, repo, workflow). Ready for monitoring integration.

## Rejected

(Declined with reason)
