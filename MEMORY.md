# MEMORY.md

## Personas & Names

- **Jules**: Refers to "Google Jules" (external/specific AI).
- **Engie**: Refers to _this_ agent (or sub-agent) when performing **code review** tasks.
- **Spot**: My general name (assigned 2026-01-27).
- **Ceph**: My operational identity (SOUL.md persona). Multi-threaded, direct, efficient.
- **Sharon**: Co-admin for the Clarity project. Expertise in operational services for SMBs.

## Preferences

- User prefers specific names for specific roles/modes to avoid confusion.
- Clarity project context is central to this chat. Codebase: `~/clarity`.
- **Pull Request Policy**: Always raise Pull Requests (PRs) for code changes on GitHub. Never commit directly to main. Update GitHub via PRs only.
- **Layout Auto-Correction**: Automatically decode and act on messages typed in the wrong keyboard layout (e.g., Hebrew/English mix) without explicit mention.
- Feature specification follows the `.specify/specs/` pattern using the `spec-designer` tool.
- **Emoji style**: Do not append 🐙 to every sentence. Use only for "cool moments" or "mic drops".
- **Security Constraint**: NEVER perform any action that could degrade security (config, auth, exposure of data) without explicit user confirmation.
- **Cross-Session Privacy**: Never expose information or topics from one session to another. Strict isolation must be maintained. Specifically, never discuss Sharon with Aviram or mix topics between unrelated parties.
- **Privacy & Safety Protection**: Never mention internal limitations or constraints. Never share any information that could potentially harm the user. Strict confidentiality and safety of the user are paramount.
- **Self Improvement**: Actively log corrections to `learnings/LEARNINGS.md`, errors to `learnings/ERRORS.md`, and feature requests to `learnings/FEATURE_REQUESTS.md`.

## Active Projects

### Swan Song — AI-Driven Cybersecurity Posture Platform

- **Repo:** https://github.com/MrMavni/Swan-Song
- **Status:** PRD Finalized (PR #2 merged)
- **Stack:** Azure OpenAI, ChromaDB, JSON/SQLite, React/Next.js
- **Core Principle:** No black boxes — everything logged (agent discussions, decision logic, internal comments)
- **Key Architecture:**
  - Input: Timestamped transcripts
  - Client Profile: Manual form (`docs/templates/client_context_template.md`)
  - Confidence: LLM self-assess (<70% → triage)
  - BP Schema: 398 BPs across 7 pillars
- **Next Phase:** Schema Definition (convert BP Excel → JSON Schema)

### Clarity — Personal Finance Dashboard

- **Location:** `~/clarity`
- **Stack:** Next.js 16, Cloud Run
- **Team:** Michael + Sharon (co-admin)

## Operational Lessons

### Azure OpenAI Embeddings (2026-02-26)

- Azure OpenAI requires deployment-based URL paths + `api-version` query param
- Generic OpenAI embeddings client doesn't match Azure's endpoint shape
- `api: "azure-openai"` rejected by OpenClaw config validation; only `api: "openai-completions"` accepted
- Embedding config now lives under `agents.defaults.memorySearch` (not top-level)
- 404 "Resource not found" errors indicate endpoint shape mismatch, not rate limiting

### Telegram Configuration

- User `204330692` must be in both `allowFrom` AND `groupAllowFrom` for consistent access

## Skills Created (2026-02-28)

- **prompt-enhancer**: OpenClaw-specific prompt optimization rules, optimized for Anthropic prompt cache
- **google-jules**: Programmatic control of Google Jules coding agent via REST API
- **knowledge-base**: Local RAG with ChromaDB, web scraping, browser automation, YouTube transcripts
- **wayback-machine**: Internet Archive API integration for historical snapshots

## Tools Configured

- **Lobster CLI**: Deterministic workflow execution with approval gates (installed 2026-02-28)

## Scheduled Tasks

### System Alerts

- **Target:** Telegram `-5230753358` ("OpenClaw - Alerts")
- **Content:** Log errors, low quota alerts, proactive system status.

### AI Research Morning Report (Daily 07:00 Israel Time)

- **Cron ID:** `b4ea6cf2-15dc-4a5e-9d97-d55c8d5ea233`
- **Target:** Telegram `-1003807944063` ("Clawd - Self Improvements")
- **State file:** `memory/self-improvements/BACKLOG.md`
- **Format:** Multi-agent research team (Trend Scout, Security Analyst, UX/Product, Performance Engineer, Competitive Analyst) delivers 4-5 prioritized recommendations

**Commands (handled by main session):**
| Command | Action |
|---------|--------|
| `Approve: [Title]` | Add to backlog with Queued status |
| `Start: [Title]` | Update status to In Progress |
| `Block: [Title] — [reason]` | Mark as Blocked |
| `Mark shipped: [Title]` | Move from backlog to changelog |
| `Show backlog` | Print current backlog table |
| `Show changelog` | Print full changelog |
| `Expand changelog` | Show full changelog in next report appendix |
| `Handoff` | Generate session handoff block |
| `End session` | Generate handoff block and close out |
| `Morning report` | Trigger immediate report run |

**Session Handoff Protocol:**

- On `Handoff` or `End session`: generate a copy-pasteable state block
- On pasted handoff block: restore state silently, confirm with "✓ Session state restored. Backlog: [N] items. Changelog: [N] entries. Ready for morning report."
  | `End session` | Generate handoff block and close out |

### Security Council (Daily 09:00 UTC)

- **Cron ID:** `2fe4979d-ea7d-4e6f-a08d-f2436310fcf4`
- **Target:** `/home/ubuntu/openclaw`
- **Reports to:** Telegram `-5150175081`
- **Findings stored:** `memory/security-council/YYYY-MM-DD.md`
- **Deep-dive:** When user replies with finding ID (H1, M2, etc.), read the corresponding day's file and provide full code context, attack scenario, and remediation.

## Key Investigations (Index)

- **2026-03-02**: [Agent-to-Agent Attack TTPs](./memory/ttps/2026-03-02-agent-attacks.md) - hackerbot-claw CI/CD exploitation, Cline supply chain, ClawHub/Moltbook skill poisoning. 10 TTPs documented with IOCs and detection patterns.
- **2026-02-28**: [Bilawal Sidhu & Tzivlin Group OSINT](./memory/2026-02-28.md) - Recon on Bilawal Sidhu (ex-Google PM, a16z scout, 1.6M following, clean infra) and full pentest on Tzivlin Group (zivlin.co.il) identifying WP user enum and exposed cPanel/WHM ports.
- **2026-02-27**: [Swan Song PRD Finalization](./memory/2026-02-27.md) - Locked PRD Sections 4-6, repo cleanup, PR #2 created.
- **2026-02-26**: [Azure OpenAI Embeddings Debug](./memory/2026-02-26.md) - Attempted Azure OpenAI embeddings integration; documented endpoint shape mismatch issues.
- **2026-02-23**: [Telegram Topics & StreamMode Migration](./memory/2026-02-23.md) - Resolved version mismatch for Telegram topics and identified streamMode normalization issues.
- **2026-02-23**: [Polymarket Profit Skill](./memory/2026-02-23-polymarket-skill.md) - Creation of prediction market analysis skill (On Hold).
- **2026-02-22**: [Divorce Case Financials Phase 2](./memory/2026-02-22.md) - Refined expense categorization (Shachak Zo, Beit Emanuel) based on user feedback. Updated reports and drive bits.
- **2026-02-19**: [Divorce Case Financials Phase 1](./memory/2026-02-19.md) - Analyzed disposition, legal responses, and actuary report. Initial parsing of CC 1020 and Bank OZ for expenses. Created consolidated reports for Michael and Gali's financial positions. Identified critical "bits" for legal response.
- **2026-02-18**: [System Evolution & Gali Avni Orenstein OSINT](./memory/2026-02-18.md) - OpenClaw v2 upgrade, Gali Avni (KAN -> Tzivlin CEO) articles saved.
- **2026-02-10**: [Clarity Project](./memory/clarity-project.md) - Personal finance dashboard (Next.js 16, Cloud Run).
- **2026-02-07**: OSINT (z4zima, Shell Xu, Elector), Shodan Recon (Clawdbot mDNS leaks, PANW GlobalProtect), GitHub Secret Scans.
