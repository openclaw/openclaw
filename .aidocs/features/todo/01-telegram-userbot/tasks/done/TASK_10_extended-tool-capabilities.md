# TASK_10: Extended Tool Capabilities

<!-- SUMMARY: Exposes userbot-specific capabilities to the agent via prompt context and tool integration -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~15k                |
| **Priority**    | P1                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 3                   |
| **Wave**        | 3                   |

---

## SDD References

| Document  | Path                                                               | Sections                                               |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 Success Criteria (all), §6 User Stories             |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.4 Message Actions, §11 Differences from Bot Channel |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-10                                                |

## Task Dependency Tree

```
TASK-09 (Actions) ───┐
                     ▼
        TASK-10 (Extended Tools) ←── you are here
                     │
                     └──► TASK-15 (Integration Tests)
```

## Description

Create the `ChannelAgentPromptAdapter` that injects userbot-specific capabilities into the agent's system prompt and ensures the `message` tool works with `channel: "telegram-userbot"`. The agent must know:

- It can delete other people's messages in DMs
- It can read full chat history
- It can forward messages between chats
- It can pin messages
- Which capabilities are currently available (based on connection state and config)

**Business value:** Enables the agent to fully leverage userbot capabilities by knowing what actions are available, making autonomous message management possible (US-1 through US-4).

---

## Context

### Related Files (from codebase research)

| File                                            | Purpose                               | Patterns to Follow                    |
| ----------------------------------------------- | ------------------------------------- | ------------------------------------- |
| `src/channels/plugins/types.core.ts` (line 287) | `ChannelAgentPromptAdapter` interface | messageToolHints, channelInstructions |
| `src/channels/plugins/types.plugin.ts`          | Plugin `agentPrompt` slot             | How prompt adapter is wired           |
| `extensions/discord/src/channel.ts`             | Discord agent prompt (if any)         | Agent prompt patterns                 |

### Code Dependencies

- Config from TASK-05 — capabilities section
- Connection state from TASK-03 — dynamic capability reporting

---

## Goals

1. Agent prompt adapter injecting userbot capabilities into system prompt
2. Dynamic capability reporting based on connection state and config
3. `message` tool works correctly with `channel: "telegram-userbot"`
4. Clear documentation of available vs unavailable actions

---

## Acceptance Criteria

**AC-1: Agent knows userbot capabilities**

- Given: Agent processes a conversation on telegram-userbot channel
- When: System prompt is built
- Then: Includes description of available actions (delete others' messages, read history, forward, pin)

**AC-2: Dynamic capability based on connection**

- Given: Userbot is disconnected
- When: Agent prompt is built
- Then: Capabilities are marked as unavailable

**AC-3: Message tool integration**

- Given: Agent decides to send via userbot
- When: `message` tool is called with `channel: "telegram-userbot"`
- Then: Message is routed through the userbot outbound adapter

**AC-4: Capability toggle in config**

- Given: `capabilities.deleteOtherMessages: false` in config
- When: Agent prompt is built
- Then: Delete others' messages is not listed as available

**AC-5: History reading exposed**

- Given: readHistory capability is enabled
- When: Agent needs chat history
- Then: getHistory operation is available and described in prompt

---

## Dependencies

**Depends on:**

- TASK-09 (Message Actions) — actions to expose

**Blocks:**

- TASK-15 (Integration Tests) — tests tool integration

---

## Files to Change

| Action | File                                                            | Scope                                    |
| ------ | --------------------------------------------------------------- | ---------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/adapters/agent-prompt.ts`      | ChannelAgentPromptAdapter implementation |
| CREATE | `extensions/telegram-userbot/src/adapters/agent-prompt.test.ts` | Unit tests                               |

---

## Risks & Mitigations

| Risk                                                    | Likelihood | Impact | Mitigation                                           |
| ------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------- |
| Prompt too verbose wastes agent tokens                  | Medium     | Low    | Keep capability list concise, use bullet points      |
| Agent confused by overlapping telegram/telegram-userbot | Medium     | Medium | Clear channel labels, explicit differences in prompt |

---

## Out of Scope

- Custom agent tools specific to userbot (e.g., "telegram_delete" tool)
- Modifying the `message` tool schema itself
- Agent training/fine-tuning for userbot usage

---

## Testing

| Type | Description                                       | File                                                            |
| ---- | ------------------------------------------------- | --------------------------------------------------------------- |
| Unit | Prompt includes all capabilities when connected   | `extensions/telegram-userbot/src/adapters/agent-prompt.test.ts` |
| Unit | Capabilities excluded when config disables them   | `extensions/telegram-userbot/src/adapters/agent-prompt.test.ts` |
| Unit | Capabilities marked unavailable when disconnected | `extensions/telegram-userbot/src/adapters/agent-prompt.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                |
| -------------- | ------ | ------------------------------------ |
| Research       | ~3k    | Study agent prompt adapter interface |
| Implementation | ~8k    | Prompt adapter + capability logic    |
| Testing        | ~4k    | Unit tests                           |
| **Total**      | ~15k   | Focused prompt task                  |

---

## Subtasks

- [ ] 1.  Create `agent-prompt.ts` with ChannelAgentPromptAdapter
- [ ] 2.  Build capability list from config + connection state
- [ ] 3.  Write messageToolHints for telegram-userbot actions
- [ ] 4.  Add channel-specific instructions (delete, forward, pin, history)
- [ ] 5.  Write unit tests for prompt generation in various states
