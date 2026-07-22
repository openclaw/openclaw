# W2: Session visibility states + membership + gateway enforcement + admin policy

Umbrella issue: openclaw/openclaw#112499 (read it). You are building phase 2 ONLY.

## Context

A sibling worktree (W1, branch feat/session-ownership-attribution) is IN FLIGHT adding: a `createdBy?: { id, label? }` identity stamped on session entries + exposed on session rows. It may land before you. Design against that contract; if it has not landed when you finish, keep your code compiling WITHOUT it by resolving "owner" as: session createdBy identity when present, else treat the acting admin as owner-equivalent. Expect a rebase later; do not duplicate W1's UI work (owner avatars, person filter, docs page).

## Goal

1. **Visibility state.** Sessions get `visibility: "shared" | "read-only" | "suggest" | "draft"`, default `"shared"`, stored with the session entry (ADDITIVE SQLite surface, lazy ensure, no schema-version bump) and exposed on session rows as an additive optional protocol field. New sessions ALWAYS start shared. A new gateway method (e.g. `session.visibility.set`) changes it; allowed callers: the session owner (createdBy identity matches the caller's identity) or any operator.admin connection. Additive protocol only; regenerate Swift/Kotlin protocol models if schemas change and commit generated output.
2. **Membership.** Additive SQLite table (per-agent DB, e.g. `session_members(session_key, identity_id, added_by, added_at)`) with lazy ensure. Gateway methods `session.members.list/add/remove`; mutation allowed for owner or admin only. Member identities come from the same identity space as createdBy (trusted-proxy user id / device label).
3. **Enforcement (core of this PR).** For sessions whose visibility is NOT "shared", non-participants (not owner, not member, not operator.admin) are FULLY INERT: reject chat.send, steering/abort, approvals actions, file-edit RPCs, and any other session-mutating method for that sessionKey at gateway admission. "suggest" enforces exactly like "read-only" in this PR (the suggestion queue is a later phase). "draft" additionally hides the session: filtered OUT of sessions.list results and session-scoped event broadcasts for non-admin, non-owner connections (extend the event scope guard layer in src/gateway/server-broadcast.ts; every new event kind needs an EVENT_SCOPE_GUARDS entry). Admins always see drafts. Identity of a connection = trusted-proxy user else paired-device identity; connections with no identity (single-user token/password auth) are treated as owner-equivalent so solo mode never locks itself out — write a test proving solo mode is unaffected.
4. **Admin policy.** ONE new config object controlling allowed modes only, fitting existing config conventions (check src/config/types.*.ts + zod schema + schema.help/labels/tags + docs), e.g. `sessions.sharing: { readOnly?: boolean; suggest?: boolean; drafts?: boolean }`, all defaulting true. When a mode is disallowed, `session.visibility.set` rejects it. No configurable default visibility, no other knobs. Config docs updated; run any generated-config-metadata gates the build has.
5. **Audit as session log.** Visibility and membership changes append a compact system-line entry to the session transcript via SessionManager.appendMessage (NEVER raw JSONL writes — see src/gateway/server-methods/AGENTS notes) and emit a gateway event. No new audit subsystem.
6. **UI (minimal, functional).** (a) Visibility picker in the session header menu, visible to owner/admins only, options gated by admin policy. (b) Membership editor: simple people picker fed by known identities (distinct createdBy values + currently paired identities). (c) Read-only/suggest non-participants: composer disabled with a short notice line; steering/approval controls hidden. (d) Drafts: non-admins simply don't see them (enforcement covers it); admins see them faded (a single CSS class + small ghost indicator is enough — full drafts UX is a later phase). Reuse existing menu/picker components; strings in en.ts only + baseline regen.

## Non-goals (do NOT build)

- NO suggestion queue mechanics, NO typing indicator, NO invite links/knock flow, NO drafts promote-flow or create-as-draft affordance, NO owner avatars/person filter/docs page (W1 owns those), NO changes to device pairing or scopes.

## Repo mechanics

Same rules as the repo demands: run `pnpm install` first; read root AGENTS.md + scoped AGENTS.md of touched dirs; oxfmt formatting; colocated behavior-level vitest with focused runs (`pnpm test <file>`); gateway tests reuse suite-level servers (src/gateway/CLAUDE.md); i18n via en.ts + `node --import tsx scripts/control-ui-i18n-verify.ts baseline`; deterministic ordering before payloads; `pnpm check:changed` at the end; conventional grouped commits with `git commit --no-verify`; do NOT push; do NOT touch CHANGELOG.md; keep prod LOC lean and check `git diff --numstat`.

## Output

Write REPORT.md in this worktree root: files changed, decisions taken, exact test commands + results, skipped items, and the precise contract you assumed from W1.
