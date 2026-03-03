# TASK_16: Documentation

<!-- SUMMARY: Provides user-facing documentation for setting up and operating the telegram-userbot channel -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | simple              |
| **Est. Tokens** | ~12k                |
| **Priority**    | P2                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 5                   |
| **Wave**        | 5                   |

---

## SDD References

| Document  | Path                                                               | Sections                                        |
| --------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | All sections (for user-facing explanation)      |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §5 Configuration, §11 Differences, §12 Security |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-16                                         |

## Task Dependency Tree

```
ALL TASKS (01-15) ───┐
                     ▼
           TASK-16 (Documentation) ←── you are here
```

## Description

Create comprehensive user-facing documentation for the telegram-userbot channel:

1. **Prerequisites:** How to get API ID and Hash from my.telegram.org
2. **Setup guide:** Step-by-step with `openclaw channels add --channel telegram-userbot`
3. **Config reference:** All configuration options with defaults and examples
4. **Architecture:** How it differs from the bot channel, why separate
5. **Coexistence:** Running both telegram (bot) and telegram-userbot simultaneously
6. **Troubleshooting:** Session invalid, flood wait, account ban, connection issues
7. **Security:** Best practices, separate account recommendation, session protection
8. **FAQ:** Common questions and answers

**Business value:** Reduces support burden and enables users to self-serve setup and troubleshooting.

---

## Context

### Related Files (from codebase research)

| File                                      | Purpose                     | Patterns to Follow                |
| ----------------------------------------- | --------------------------- | --------------------------------- |
| Existing channel docs in `docs/channels/` | Other channel documentation | Documentation structure and style |
| `docs/channels/index.md` (if exists)      | Channel listing page        | Where to add the new channel      |

### Code Dependencies

- None (documentation only)

---

## Goals

1. Complete user-facing documentation for telegram-userbot channel
2. Step-by-step setup guide from zero to working
3. Full config reference with all options
4. Troubleshooting guide for common issues
5. Security best practices section

---

## Acceptance Criteria

**AC-1: Prerequisites documented**

- Given: New user with no prior knowledge
- When: Reading prerequisites section
- Then: Can obtain API ID and Hash from my.telegram.org

**AC-2: Setup guide works end-to-end**

- Given: User has API credentials
- When: Following the step-by-step guide
- Then: Can complete setup and have a working userbot channel

**AC-3: Config reference complete**

- Given: User wants to customize the channel
- When: Reading config reference
- Then: Every config option is documented with type, default, and example

**AC-4: Troubleshooting covers common issues**

- Given: User encounters an error
- When: Checking troubleshooting section
- Then: Finds relevant solution for: session invalid, flood wait, connection lost, auth error

**AC-5: Security section covers risks**

- Given: User is setting up userbot
- When: Reading security section
- Then: Understands risks (ToS, ban potential) and mitigations (separate account, conservative rate limits)

**AC-6: Channel listing updated**

- Given: Documentation index exists
- When: User browses available channels
- Then: telegram-userbot is listed alongside other channels

---

## Dependencies

**Depends on:**

- All tasks TASK-01 through TASK-15 (documentation reflects final implementation)

**Blocks:**

- None (final task)

---

## Files to Change

| Action | File                                | Scope                                                    |
| ------ | ----------------------------------- | -------------------------------------------------------- |
| CREATE | `docs/channels/telegram-userbot.md` | Full channel documentation                               |
| UPDATE | `docs/channels/index.md`            | Add telegram-userbot to channel listing (if file exists) |

---

## Risks & Mitigations

| Risk                           | Likelihood | Impact | Mitigation                                             |
| ------------------------------ | ---------- | ------ | ------------------------------------------------------ |
| Documentation becomes outdated | Medium     | Low    | Keep close to code, update with code changes           |
| my.telegram.org UI changes     | Medium     | Low    | Use generic instructions, note that UI may vary        |
| Users skip security section    | Medium     | Medium | Add warnings in setup guide, not just security section |

---

## Out of Scope

- Video tutorials
- Automated screenshot generation
- Localization / translations
- API reference docs (auto-generated from code)

---

## Testing

| Type   | Description                              | File |
| ------ | ---------------------------------------- | ---- |
| Manual | Follow setup guide on clean system       | —    |
| Manual | Verify all config options are documented | —    |
| Manual | Check links and references work          | —    |

---

## Estimated Context

| Phase          | Tokens | Notes                                      |
| -------------- | ------ | ------------------------------------------ |
| Research       | ~3k    | Review existing docs, final implementation |
| Implementation | ~8k    | Write all documentation sections           |
| Review         | ~1k    | Proofread and verify accuracy              |
| **Total**      | ~12k   | Straightforward writing task               |

---

## Subtasks

- [ ] 1.  Write Prerequisites section (my.telegram.org, API credentials)
- [ ] 2.  Write Setup Guide (step-by-step with CLI commands)
- [ ] 3.  Write Config Reference (all options with types, defaults, examples)
- [ ] 4.  Write Architecture section (bot vs userbot, why separate)
- [ ] 5.  Write Coexistence guide (running both channels)
- [ ] 6.  Write Troubleshooting section (session, flood, ban, connection)
- [ ] 7.  Write Security section (risks, mitigations, best practices)
- [ ] 8.  Write FAQ
- [ ] 9.  Update channel listing index
