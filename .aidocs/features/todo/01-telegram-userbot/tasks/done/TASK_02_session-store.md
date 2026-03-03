# TASK_02: Session Store

<!-- SUMMARY: Securely persists GramJS session strings so userbot survives restarts without re-authentication -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | simple              |
| **Est. Tokens** | ~10k                |
| **Priority**    | P0                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 1                   |
| **Wave**        | 1                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                  |
| --------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 SC-10 (Session persistence), §7 Constraints            |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.1 Setup Adapter, §9 Connection Lifecycle, §12 Security |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-02                                                   |

## Task Dependency Tree

```
TASK-02 (Session Store) <-- you are here
   |
   |---> TASK-03 (Connection Manager) -- loads/saves session
   |---> TASK-06 (Plugin Entry) -- uses store in setup
   +---> TASK-13 (CLI Setup) -- saves session after auth
```

## Description

Implement a file-based session store that reads and writes GramJS session strings to `~/.openclaw/credentials/telegram-userbot-{accountId}.session`. Session strings are sensitive (equivalent to full account access) and must be stored with `chmod 600` permissions.

**Business value:** Users authenticate once and the session persists across restarts (SC-10 from spec), avoiding repeated phone+code auth.

---

## Context

### Related Files (from codebase research)

| File                                | Purpose                | Patterns to Follow                                   |
| ----------------------------------- | ---------------------- | ---------------------------------------------------- |
| `src/config/config.ts`              | Config file management | File path resolution, credentials directory patterns |
| `extensions/discord/src/runtime.ts` | Runtime getters        | How extensions access system paths                   |
| `src/plugin-sdk/index.ts`           | Plugin SDK exports     | RuntimeEnv type for accessing paths                  |

### Code Dependencies

- `node:fs/promises` — file read/write
- `node:path` — path construction
- `node:os` — home directory resolution

---

## Goals

1. Load/save/clear session strings from `~/.openclaw/credentials/` with `chmod 600`
2. Auto-create credentials directory if missing
3. Support multiple accounts via `accountId` parameter

---

## Acceptance Criteria

**AC-1: Load session**

- Given: Session file exists at `~/.openclaw/credentials/telegram-userbot-default.session`
- When: `load("default")` is called
- Then: Returns the session string content

**AC-2: Load missing session**

- Given: No session file exists for account "new"
- When: `load("new")` is called
- Then: Returns `null`

**AC-3: Save session**

- Given: A valid session string
- When: `save("default", sessionString)` is called
- Then: File is written at the correct path with `0o600` permissions

**AC-4: Auto-create credentials directory**

- Given: `~/.openclaw/credentials/` does not exist
- When: `save("default", sessionString)` is called
- Then: Directory is created with `0o700` permissions, then file is written

**AC-5: Clear session**

- Given: Session file exists
- When: `clear("default")` is called
- Then: File is deleted

**AC-6: Check existence**

- Given: Session file may or may not exist
- When: `exists("default")` is called
- Then: Returns boolean without reading file content

---

## Dependencies

**Depends on:**

- None (foundation task)

**Blocks:**

- TASK-03 (Connection Manager) — loads session on start, saves on stop
- TASK-06 (Plugin Entry) — session check in setup adapter
- TASK-13 (CLI Setup) — saves session after interactive auth

---

## Files to Change

| Action | File                                                    | Scope                                          |
| ------ | ------------------------------------------------------- | ---------------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/session-store.ts`      | SessionStore class with load/save/clear/exists |
| CREATE | `extensions/telegram-userbot/src/session-store.test.ts` | Unit tests with temp directory                 |

---

## Risks & Mitigations

| Risk                                   | Likelihood | Impact | Mitigation                                              |
| -------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| Permission denied on credentials dir   | Low        | Medium | Clear error message with fix instructions               |
| Session string leaked in logs          | Low        | High   | Never log session content, only log file path existence |
| Concurrent access (multiple processes) | Low        | Low    | Atomic write pattern (write to .tmp then rename)        |

---

## Out of Scope

- Encryption of session at rest (future enhancement, session is already opaque string)
- 1Password integration for session storage
- Key rotation

---

## Testing

| Type | Description                                | File                                                    |
| ---- | ------------------------------------------ | ------------------------------------------------------- |
| Unit | Load/save/clear/exists with temp directory | `extensions/telegram-userbot/src/session-store.test.ts` |
| Unit | Auto-create credentials directory          | `extensions/telegram-userbot/src/session-store.test.ts` |
| Unit | File permissions verification              | `extensions/telegram-userbot/src/session-store.test.ts` |
| Unit | Missing file returns null                  | `extensions/telegram-userbot/src/session-store.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                               |
| -------------- | ------ | ----------------------------------- |
| Research       | ~2k    | Check existing credentials patterns |
| Implementation | ~5k    | Session store class                 |
| Testing        | ~3k    | Unit tests with temp dirs           |
| **Total**      | ~10k   | Simple file I/O task                |

---

## Subtasks

- [ ] 1.  Create `session-store.ts` with SessionStore class
- [ ] 2.  Implement `load(accountId)` — read file, return string or null
- [ ] 3.  Implement `save(accountId, session)` — atomic write with chmod 600
- [ ] 4.  Implement `clear(accountId)` — delete file
- [ ] 5.  Implement `exists(accountId)` — check file existence
- [ ] 6.  Implement auto-create credentials directory with chmod 700
- [ ] 7.  Write unit tests using temp directory (node:os tmpdir)
