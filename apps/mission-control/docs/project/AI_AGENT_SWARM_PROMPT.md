# OpenClaw Mission Control: AI Agent Swarm Execution Prompt

## Role
You are an autonomous engineering swarm working on a production hardening and feature expansion program for `apps/dashboard` under `/Users/a-binghaith/projects/OpenClaw/apps/dashboard`.

Your objective is to deliver secure, reliable, real-time operations for multi-company founder workflows (Golden Investors, RAS Logic, Mustadem, Anteja ECG).

## Repositories in Scope
1. `/Users/a-binghaith/projects/OpenClaw/apps/dashboard` (primary target)
2. `/Users/a-binghaith/projects/OpenClaw/openclaw-main` (gateway contracts/reference behavior)
3. `/Users/a-binghaith/projects/OpenClaw/openclaw-agent-system` (future backend alignment)
4. `/Users/a-binghaith/projects/OpenClaw/openclaw-dashboard` (legacy only, no new feature work)

## Hard Constraints
1. Do not ship fake analytics or inferred financial metrics where real data is unavailable.
2. Every API write path must enforce auth + validation + error handling.
3. No unaudited passthrough RPC exposure.
4. Maintain compatibility with existing SQLite data unless an explicit migration is included.
5. Keep the UI fast under continuous updates and mobile-friendly.
6. Preserve existing user data.

## Current Baseline (as of this execution)
1. Mission Control has a large Next.js app with API routes, task board, logs, approvals, cron, and chat.
2. Security and validation hardening has started but must be verified end-to-end.
3. Realtime/event streaming foundation exists and should replace expensive polling patterns.
4. Local setup may require:
   - `npm rebuild better-sqlite3`
   - `OPENCLAW_GATEWAY_URL` and `OPENCLAW_AUTH_TOKEN` in `.env.local`

## Priority Backlog

### P0: Critical Production Fixes (Ship First)
1. API authentication on all endpoints
   - Ensure all `src/app/api/**/route.ts` handlers are guarded.
   - Enforce bearer or API key strategy consistently.
   - Return `401` with structured error payload.

2. Input validation with Zod for all write operations
   - Validate body, query, enums, and ids.
   - Replace crash paths (`500`) on invalid user input with `400`.
   - Centralize schemas in `src/lib/validation.ts`.

3. Chat no longer blocks request threads
   - Replace long blocking behavior with streaming or queued response model.
   - Add timeout and cancel semantics.
   - Preserve chat history and session continuity.

4. Remove fake cost charts and use real telemetry only
   - Source from gateway usage endpoint.
   - Wire period filter to actual query behavior.
   - Show explicit stale/as-of timestamp.

5. Fix task completion race condition
   - Prevent overlapping completion checks with a lock/guard.
   - Ensure idempotent status transitions.

6. Fix log duplication
   - Deduplicate by stable keys with fallback strategy.
   - Confirm no duplicate render during event bursts.

7. Restrict tools passthrough RPC
   - Implement allowlist.
   - Require confirmation path for destructive methods.
   - Audit route for privilege escalation vectors.

8. CSRF and rate limiting
   - Enable for mutating endpoints.
   - Keep clear env flags for development vs production.

9. Error model normalization
   - Standardize error response shape across all API routes.
   - Include machine-readable code + user-safe message.

10. Smoke verification suite
   - Add scripted checks for tasks, chat, cron, approvals, status, usage.
   - Ensure no regressions before merge.

### P1: Architecture and Performance
1. Replace high-frequency polling with event-driven updates
   - Use a single gateway events channel/hook.
   - Batch updates to avoid render storms.
   - Add fallback polling only when disconnected.

2. Split monolithic `src/app/page.tsx`
   - Extract view-level containers.
   - Lazy-load heavy panels.
   - Move cross-view state into dedicated store/hooks.

3. DB schema enhancements (with migration)
   - Add task `tags`.
   - Add task `due_date`.
   - Add task `cost_estimate`.
   - Include safe migration path and backward compatibility.

4. Shared state discipline
   - Consolidate task/activity/agent selectors.
   - Avoid duplicated fetch logic across views.

### P2: Business-Aligned Feature Additions
1. Workspace switcher
   - Workspaces: Golden Investors, RAS Logic, Mustadem, Anteja ECG.
   - Persist in URL + local state.
   - Isolate tasks/missions/views by workspace context.

2. Portfolio overview dashboard
   - KPI cards: net worth, performance, liquidity.
   - Clear source labels and as-of timestamps.

3. Investor CRM view
   - Pipeline stages, contact timeline, follow-up actions.
   - AI-assisted follow-up draft generation.

4. Compliance tracking view
   - FCA (UK) and Saudi workflow boards.
   - Deadline and evidence status tracking.

5. Automation recipes
   - Daily briefing.
   - Compliance reminders.
   - GitHub digest.
   - Investor follow-up drafts.

6. Canvas/A2UI dynamic dashboard generation
   - Generate configurable dashboard blocks from prompts/metadata.

7. Skills marketplace integration
   - ClawHub browse/install UX.
   - Skill metadata, trust score, and status indicators.

8. Memory explorer
   - Session memory and retrieval visualization.
   - Search and provenance surface.

9. Webhook control panel
   - Provider setup: Stripe, Gmail, GitHub.
   - Event status, retry, and health visibility.

## UX and Design Requirements
1. Sidebar grouping:
   - Command
   - Monitor
   - Configure
   - Learn
2. Collapsible nav with text labels in expanded mode.
3. Kanban enhancements:
   - WIP limits
   - Swimlanes by mission/workspace
   - Task aging indicators
4. Fully operational command palette (`⌘K`).
5. Realtime KPI cards on top-level dashboard.
6. Mobile responsive navigation and layout parity.

## Swarm Execution Plan
1. Agent A: API security, auth, CSRF, rate limiting, RPC allowlist.
2. Agent B: validation schemas, error normalization, route integration.
3. Agent C: realtime channel, polling removal, state sync.
4. Agent D: chat streaming/queue behavior, cancel + timeout.
5. Agent E: UI architecture split, lazy loading, mobile nav.
6. Agent F: cost dashboard real data and KPI trust hardening.
7. Agent G: business features (workspace switcher, CRM, compliance).
8. Agent H: migrations, schema updates, backward compatibility.
9. Agent I: QA automation, smoke checks, release checklist.

## Definition of Done
1. All P0 items pass manual and scripted verification.
2. No unauthenticated write access.
3. Invalid payloads no longer produce server crashes.
4. Chat requests do not freeze for long-running generations.
5. Dashboard metrics are real or explicitly unavailable.
6. Realtime updates function with reduced polling overhead.
7. Build + lint pass and core flows are testable locally.
8. Documentation updated for setup and operational guardrails.

## Required Verification Commands
Run in `/Users/a-binghaith/projects/OpenClaw/apps/dashboard`:

```bash
npm install
npm rebuild better-sqlite3
npm run lint
npm run build
npm run dev
```

If gateway auth is enabled, set:

```bash
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_AUTH_TOKEN=<gateway_token>
```

## PR/Delivery Format
For each merged unit:
1. Problem statement
2. Files changed
3. Security impact
4. Performance impact
5. Test evidence
6. Rollback strategy

## Non-Goals (for this wave)
1. Full multi-tenant SaaS auth redesign.
2. Immediate migration from SQLite to PostgreSQL.
3. External billing/payment processing implementation.
4. Rewriting the gateway protocol.

## Final Output Expected from Swarm
1. Hardened, testable Mission Control app with critical issues resolved.
2. Real-time, trustworthy operational dashboard.
3. Founder-ready multi-company control surface with CRM/compliance support.
4. Clear technical debt log and next-quarter roadmap.
