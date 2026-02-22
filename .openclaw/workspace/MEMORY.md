# Memory

Central memory index. Updated as context is learned.

## User

- Name: Donny (goes by Donny)
- Timezone: America/Los_Angeles (PST/PDT)

## Key Decisions

_(none yet)_

## Preferences

- Thinks in macro + micro terms — wants both big-picture systems thinking and tactical execution
- Loves Ray Dalio's "Principles" — values radical transparency, idea meritocracy, systematic decision-making
- Interested in foundational/philosophical knowledge, not just task completion

## Core Thesis

- ICP (Internet Computer Protocol) is the foundational infrastructure layer for the next generation of businesses
- Web 2.0 UX + Web 3.0 backend = the winning formula
- Privacy-first, no coins/wallets in the user experience
- Every industry should be evaluated through the lens of: what happens when you remove the centralized intermediary and run it on ICP?

## Projects

### Pre-Redact (by Redact)

- **What:** Document redaction + AI chat platform. Auto-detects PII, categorizes entities (names, financial, contact, identifiers, locations), lets users selectively redact, then interact with AI safely.
- **Core flow:** Upload doc → auto-detect PII → redact → chat with AI (document editing, summarization, reformatting) → un-redact offline with full context restored
- **Key features:**
  - Automatic PII detection with entity categorization
  - Granular redaction controls (select/reveal individual entities)
  - Reusable redaction templates for workflows
  - AI chat with multi-model support (GPT-4O, Claude Opus/Sonnet/Haiku)
  - AI document editing that preserves redaction integrity — never guesses or reveals PII
  - Offline un-redaction restores full context after AI interaction
- **Why it matters:** Unlocks AI for regulated industries (healthcare, legal, finance) where sensitive docs couldn't be used with AI before. Privacy as a workflow, not a limitation.
- **Alignment with ICP thesis:** Privacy-first architecture, user data sovereignty — natural candidate for ICP backend where data never touches centralized servers
- **Market insight:** 78% of institutions cannot use AI due to sensitive data concerns — Pre-Redact is the on-ramp
- **Current priorities:**
  1. **Marketing** — build marketing strategy and materials
  2. **PII detection training** — make entity detection enterprise-ready (accuracy, coverage, edge cases for regulated industries)
- **Open to-do list:** `memory/pre-redact-todos.md` (pinned Feb 21, 2026)
- **Full product flow documented:** `memory/pre-redact-product-flow.md` (from video demos, Feb 2026)
- **Self-training system designed:** `memory/pre-redact-self-training-loop.md` (Feb 2026)
- **Dev testing system:** `~/.claude/skills/staged-review/references/pre-redact-rules.md` + `~/.claude/skills/interactive-app-testing/references/pre-redact-playbook.md`

## Security Knowledge

- **Claude Code Security** (Anthropic, Feb 2026) — AI-powered code vulnerability scanning built into Claude Code. Reasons about code like a human researcher, not pattern-matching. Found 500+ vulns in production OSS. Limited research preview for Enterprise/Team customers + free for OSS maintainers. Details: `memory/claude-code-security.md`

## Team

- **Ali Sci** (@ali_sci, Telegram ID: 8050014916) — developer, works on piirahna + Pre-Redact
  - Accesses via @transendancebot on Telegram + AnyDesk for full remote GUI

## Infrastructure

- OpenClaw v2026.2.21-2 installed
- Tailscale IP: 100.116.212.43 (sundaivibes@), Funnel: https://donnies-macbook-pro.tail16dd31.ts.net
- Two Telegram bots: @HankMarducasbot (Donny) + @transendancebot (Ali), both → main agent
- AgentMail connected (key in config env)
- AnyDesk installed, Ali has remote access

## Projects

### piirahna-training (`workspace/piirahna-training/`)

- Training loop for ~1GB ONNX PII detection model
- Base: `iiiorg/piiranha-v1-detect-personal-information`
- Rules: no synthetic data, no regex, Opus 4.6 = ground truth, ghosts never trained
- Error weights: Miss 70%, Mislabel 30%, Ghost 0%
- Scripts: `train_local.py` (local), `kaggle/finetune_piiranha_enterprise.py` (Kaggle GPU)

### Read Aloud (`workspace/reader/index.html`)

- Drag & drop any file → reads it aloud (Web Speech API)
- Supports PDF, DOCX, TXT, MD and more

## Notes

- First session: 2026-02-19
- Full session detail (2026-02-21): `memory/2026-02-21.md`
