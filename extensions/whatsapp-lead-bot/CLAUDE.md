# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm run build    # TypeScript compilation to /dist
npm run dev      # TypeScript watch mode
npm run clean    # Remove build artifacts
npm run test     # Run vitest tests
```

Tests use vitest with real SQLite (temp DBs). All classes are fully testable via constructor-injected fakes.

## Architecture

This is an **OpenClaw plugin** that intercepts WhatsApp messages to qualify leads via LLM before handing off to human agents.

### Entry Point & Composition Root

`index.ts` is the single composition root. It exports a `plugin` object with a `register(api)` function that:

1. Validates config via Zod schema (`src/config/schema.ts`)
2. Initializes SQLite database with migrations
3. Wires all classes with their interface dependencies
4. Registers two plugin hooks: `message_received` and `message_sending`
5. Starts the follow-up scheduler interval and registers cleanup

**No concrete class is imported outside `index.ts`.**

### Plugin Hooks

- **`message_received`** — Main processing pipeline for incoming messages. Returns `{ suppress: true }` to block OpenClaw's default LLM processing. Pipeline: account filter → self-message filter → handoff detection → admin commands → block check → 3-layer rate limit (circuit breaker → global → per-lead) → opt-out → media → qualification.
- **`message_sending`** — Detects human agent takeover when a non-OpenClaw-initiated message is sent to a lead still in bot handling.

### Key Interfaces (DI contracts)

| Interface     | File                                         | Implemented By                                                |
| ------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `Database`    | `src/database.ts`                            | `SqliteDatabase` in `src/database/connection.ts`              |
| `LLMProvider` | `src/engine/qualifier.ts` (inline)           | Adapter wrapping `api.runtime.llm` in `index.ts`              |
| `Runtime`     | `src/notifications/agent-notify.ts` (inline) | Adapter wrapping `api.runtime.channel.whatsapp` in `index.ts` |

### Core Components

- **QualificationEngine** (`src/engine/qualifier.ts`) — Sends lead context + message to LLM, extracts structured qualification data (location, interest, budget, timeline). Prompts in `src/engine/prompts.ts`.
- **RateLimitCoordinator** (`src/rate-limit/coordinator.ts`) — Orchestrates 3-layer rate limiting: circuit breaker → global → per-lead.
- **CircuitBreaker** (`src/rate-limit/circuit-breaker.ts`) — Emergency stop. Trips at 80% hit rate over 5min window. WhatsApp alerts on trip/reset.
- **GlobalRateLimiter** (`src/rate-limit/global-limiter.ts`) — System-wide 1000 msg/hr cap across all leads.
- **RateLimiter** (`src/rate-limit/limiter.ts`) — Per-lead atomic check-and-record via DB transaction.
- **AdminCommandHandler** (`src/admin/commands.ts`) — `/status`, `/block`, `/unblock`, `/handoff`, `/clear-limit`, `/recent`, `/rate-status`, `/reset-breaker`, `/help` commands sent by agent numbers.
- **AgentNotifier** (`src/notifications/agent-notify.ts`) — Sends WhatsApp notifications to configured agent numbers on key events (new lead, qualified, handoff, rate limit). Tags messages with `openclawInitiated: true` to prevent loops.
- **HandoffManager** (`src/handoff/manager.ts`) — Updates lead status and logs handoff events.
- **MediaHandler** (`src/media/handler.ts`) — Acknowledges media uploads with generic responses.

### Database

SQLite via `better-sqlite3`. Schema in `src/database/schema.ts` (version 3). Tables: `leads` (qualification + rate limit counters), `handoff_log` (audit trail), `global_rate_limit` (singleton system-wide counter), `circuit_breaker` (singleton emergency stop state). All rate limit operations use DB transactions for atomicity.

### Multi-Account Support

The plugin filters messages by `whatsappAccounts` config array. Runtime adapters (`getRuntime(accountId)`) are per-account for sending messages. Self-chat isolation prevents the bot from responding to messages sent by the account owner (detected via `metadata.sentByAccountOwner`).

## Configuration

All config comes from `api.pluginConfig` (validated by `src/config/schema.ts`). Key settings: `whatsappAccounts`, `agentNumbers`, `rateLimit.*`, `followup.*`, `qualificationPrompt`. Database path defaults to `{stateDir}/whatsapp-lead-bot/leads.db`.
