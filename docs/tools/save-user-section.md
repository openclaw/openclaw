---
summary: "Agent tool: write allowlisted per-user app sections into users/<appUserId>.md"
read_when:
  - Modifying the per-user file write path or the Havaya/AgentGlob integration
  - Adding a new app-writable section or changing the writable allowlist
title: "Save User Section"
---

# `save_user_section` (per-user app sections)

`save_user_section` lets an agent publish a small, **allowlisted** set of fields
into the chatting user's **per-user workspace file** — `workspace/users/<appUserId>.md` —
as delimited marker sections. An integrating web app then reads those sections
back over HTTP (see the dashboard reader, below) and renders them, with no app
redeploy.

It is the **write half** of the Havaya per-user integration. The read half is the
dashboard route `GET /api/public/chat/{agent}/user-file` (repo
`cryptolir/openclaw-dashboard`).

## What it writes

- File: `path.join(workspaceDir, "users", appUserId + ".md")`, with a
  path-containment check (the resolved path must stay inside `workspace/users/`).
- Format: HTML-comment marker sections, invisible in rendered markdown:

  ```
  <!-- app:User_D_Prompt:start -->
  …inner text…
  <!-- app:User_D_Prompt:end -->
  ```

- The write is an **upsert**: if the section's markers already exist the inner
  text is replaced in place; otherwise the section is appended. Duplicate or
  malformed markers cause the write to **fail closed** (it throws rather than
  guess), matching the reader's duplicate-marker `500`.

## Writable allowlist

Only these section names are writable (`WRITABLE_SECTIONS` in
`src/agents/tools/save-user-section.ts`); any other name is rejected:

| Section | Meaning |
|---|---|
| `User_D_Prompt` | up to ~5 short suggested prompts (one per line) shown as clickable starters on the app home page |
| `app_note` | one short per-user note/focus shown on the home page |

This list is intentionally narrow so the tool can never overwrite `SOUL.md`,
`MEMORY.md`, or arbitrary workspace files.

## Identity — `appUserId` (no user id passed by the agent)

The agent never passes a user id. Identity is resolved **server-side** from the
session:

1. The app (Havaya) sends the signed-in user's id (Clerk `userId`) as
   `appUserId` in the public chat `POST` body.
2. The dashboard forwards it into the gateway `chat.send` params
   (`appUserId` in `ChatSendParamsSchema`, `src/gateway/protocol/schema/logs-chat.ts`).
3. The gateway persists it on the session entry — `SessionEntry.appUserId`
   (`src/config/sessions/types.ts`), written in `chat.send`
   (`src/gateway/server-methods/chat.ts`) via `updateSessionStoreEntry` before
   dispatch.
4. `save_user_section` reads it back with `resolveAppUserId(agentSessionKey)`
   (`loadSessionEntry` → `entry.appUserId`), lowercases it, and validates it
   against `^[A-Za-z0-9_-]+$`. If there is no `appUserId` on the session
   (e.g. a Telegram-only user), the tool is **not registered** for that turn.

The same lowercased `appUserId` is the on-disk filename the dashboard reader
resolves, so writer and reader agree on identity by construction.

## Wiring

- Tool factory: `createSaveUserSectionTool({ config, agentSessionKey, workspaceDir })`
  in `src/agents/tools/save-user-section.ts`; registered in
  `src/agents/openclaw-tools.ts` (added to the tools array only when it resolves
  an `appUserId`).
- Pure core: `upsertSection(fileContent, section, content)` and
  `resolveAppUserId(agentSessionKey)` are pure/unit-tested
  (`src/agents/tools/save-user-section.test.ts`).

## Agent guidance (workspace `AGENTS.md`)

The owning agent's `workspace/AGENTS.md` tells it *when* to call the tool — after
it has learned enough about the user to suggest useful prompts — and that the
write is an upsert (keep it current, don't append duplicates). For the `life`
agent this lives under the **App Profile Sections (Havaya web app)** section.

## Security notes

- Allowlist + containment: only the two sections above, only under
  `workspace/users/`.
- Fail-closed on ambiguous markers (never silently overwrite).
- Identity is server-resolved from the persisted session, never taken from the
  model's arguments.
