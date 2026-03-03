# TASK_13: CLI Setup Wizard

<!-- SUMMARY: Provides interactive CLI flow for users to authenticate their Telegram account and configure the userbot channel -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~20k                |
| **Priority**    | P1                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 4                   |
| **Wave**        | 4                   |

---

## SDD References

| Document  | Path                                                               | Sections                                  |
| --------- | ------------------------------------------------------------------ | ----------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §7 Constraints (Auth: phone + code + 2FA) |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.1 Setup Adapter                        |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-13                                   |

## Task Dependency Tree

```
TASK-02 (Session) ────┐
TASK-05 (Config) ─────┤
TASK-06 (Plugin) ─────┤
                      ▼
         TASK-13 (CLI Setup Wizard) ←── you are here
```

## Description

Implement the CLI setup wizard for `openclaw channels add --channel telegram-userbot`. This is the user-facing onboarding flow that:

1. **Step 1 — API credentials:** Prompt for API ID and API Hash (from my.telegram.org)
2. **Step 2 — Phone authentication:** Prompt for phone number → send code → prompt for code → optional 2FA password
3. **Step 3 — Verify & save:** Test connection with `getMe()`, save session string to credentials dir, save apiId/apiHash to config, display "Connected as @username (ID: 123)"

Must also support:

- Non-interactive mode: `--api-id X --api-hash Y` (requires existing session)
- Re-authentication when session already exists
- Error handling for wrong code, expired code, invalid 2FA

The setup adapter integrates with OpenClaw's `ChannelOnboardingAdapter` pattern used by other channels.

**Business value:** Makes the setup process smooth and foolproof — users go from "I want to use userbot" to "connected" in under 2 minutes.

---

## Context

### Related Files (from codebase research)

| File                                          | Purpose                              | Patterns to Follow                                               |
| --------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `src/channels/plugins/onboarding-types.ts`    | `ChannelOnboardingAdapter` interface | getStatus, configure, dmPolicy patterns                          |
| `src/channels/plugins/onboarding/telegram.ts` | Telegram bot onboarding              | How the existing bot channel handles setup                       |
| `src/channels/plugins/onboarding/discord.ts`  | Discord onboarding                   | Interactive token-based setup flow                               |
| `extensions/irc/src/onboarding.ts`            | IRC onboarding                       | Extension-based onboarding pattern                               |
| `extensions/googlechat/src/onboarding.ts`     | Google Chat onboarding               | Multi-step auth onboarding                                       |
| `src/channels/plugins/onboarding/helpers.ts`  | Onboarding helpers                   | `promptSingleChannelToken`, `patchChannelConfigForAccount`, etc. |
| `src/channels/plugins/types.adapters.ts`      | Setup adapter type                   | `applyAccountConfig`, `validateInput`                            |

### Code Dependencies

- `UserbotClient` from TASK-01 — `connectInteractive()` for auth flow
- `SessionStore` from TASK-02 — `save()` to persist session after auth
- Config schema from TASK-05 — validate config before saving
- `openclaw/plugin-sdk` — onboarding helpers, config patching

---

## Goals

1. Interactive setup flow: API credentials → phone auth → verify → save
2. Non-interactive mode for automated/scripted setup
3. Re-auth flow for existing sessions
4. Clear error messages for auth failures
5. Integration with OpenClaw onboarding system

---

## Acceptance Criteria

**AC-1: Full interactive setup**

- Given: User runs `openclaw channels add --channel telegram-userbot`
- When: User enters apiId, apiHash, phone number, verification code
- Then: Session is saved, config is updated, shows "Connected as @username (ID: 123)"

**AC-2: 2FA support**

- Given: User's Telegram account has 2FA enabled
- When: After phone code verification
- Then: Prompts for 2FA password, completes auth

**AC-3: Wrong code handling**

- Given: User enters incorrect verification code
- When: Auth fails
- Then: Shows error "Invalid code", allows retry (up to 3 attempts)

**AC-4: Expired code handling**

- Given: Verification code has expired
- When: Auth fails with PHONE_CODE_EXPIRED
- Then: Shows "Code expired", offers to resend code

**AC-5: Non-interactive mode**

- Given: `--api-id 123 --api-hash abc` flags provided with existing session
- When: Setup runs
- Then: Verifies connection using existing session, updates config

**AC-6: Re-auth existing session**

- Given: Session file already exists
- When: User runs setup
- Then: Asks "Session exists. Re-authenticate?" — if yes, creates new session

**AC-7: Config saved correctly**

- Given: Successful authentication
- When: Setup completes
- Then: `channels.telegram-userbot.apiId` and `apiHash` are in config, session file at correct path

---

## Dependencies

**Depends on:**

- TASK-02 (Session Store) — save session after auth
- TASK-05 (Config Schema) — validate and save config
- TASK-06 (Plugin Entry) — setup adapter hooks into plugin

**Blocks:**

- None (end-user UX task)

---

## Files to Change

| Action | File                                                 | Scope                                    |
| ------ | ---------------------------------------------------- | ---------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/onboarding.ts`      | ChannelOnboardingAdapter implementation  |
| UPDATE | `extensions/telegram-userbot/src/adapters/setup.ts`  | Connect onboarding flow to setup adapter |
| CREATE | `extensions/telegram-userbot/src/onboarding.test.ts` | Unit tests for setup flow                |

---

## Risks & Mitigations

| Risk                                  | Likelihood | Impact | Mitigation                                 |
| ------------------------------------- | ---------- | ------ | ------------------------------------------ |
| Phone number format issues            | Medium     | Low    | Validate E.164 format, suggest format hint |
| Telegram sends code to another device | Medium     | Low    | Inform user to check Telegram app / SMS    |
| Rate limit on auth attempts           | Low        | Medium | Wait and inform user of cooldown           |
| API ID/Hash invalid                   | Medium     | Low    | Validate before phone auth step            |

---

## Out of Scope

- Web-based setup UI
- QR code login (possible future enhancement)
- Automated phone number verification
- Bot token-based auth (that's the existing telegram channel)

---

## Testing

| Type | Description                                     | File                                                 |
| ---- | ----------------------------------------------- | ---------------------------------------------------- |
| Unit | Interactive flow with mocked prompts and client | `extensions/telegram-userbot/src/onboarding.test.ts` |
| Unit | Non-interactive mode with existing session      | `extensions/telegram-userbot/src/onboarding.test.ts` |
| Unit | Wrong code retry logic                          | `extensions/telegram-userbot/src/onboarding.test.ts` |
| Unit | Re-auth flow                                    | `extensions/telegram-userbot/src/onboarding.test.ts` |
| Unit | Config saved correctly after setup              | `extensions/telegram-userbot/src/onboarding.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                              |
| -------------- | ------ | ---------------------------------- |
| Research       | ~5k    | Study existing onboarding patterns |
| Implementation | ~10k   | Onboarding adapter, setup flow     |
| Testing        | ~5k    | Unit tests with mocked I/O         |
| **Total**      | ~20k   | Interactive flow task              |

---

## Subtasks

- [ ] 1.  Create `onboarding.ts` skeleton implementing ChannelOnboardingAdapter
- [ ] 2.  Implement `getStatus()` — return configured/unconfigured state
- [ ] 3.  Implement `configure()` — Step 1: prompt for apiId and apiHash
- [ ] 4.  Implement `configure()` — Step 2: phone auth (number → code → 2FA)
- [ ] 5.  Implement `configure()` — Step 3: verify, save session, save config
- [ ] 6.  Handle error cases: wrong code, expired code, invalid 2FA, rate limit
- [ ] 7.  Support non-interactive mode (flags → config + existing session)
- [ ] 8.  Support re-auth when session exists
- [ ] 9.  Wire onboarding adapter into plugin registration
- [ ] 10. Write unit tests with mocked prompts and client
