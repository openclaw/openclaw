# Prompt & Context Audit

Audit of the OpenClaw system prompt, bootstrap injection, tool schemas, and skills injection.

Generated: 2026-03-29

## 1. System Prompt Breakdown

Source: `src/agents/system-prompt.ts` — `buildAgentSystemPrompt()`

| #   | Section                          | Est. Chars         | Est. Tokens   | Content Summary                                                              | Can Shorten?                                                    |
| --- | -------------------------------- | ------------------ | ------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Identity line                    | ~50                | ~13           | "You are a personal assistant running inside OpenClaw."                      | No                                                              |
| 2   | ## Tooling                       | ~2,500             | ~625          | Tool list with summaries + usage guidance, ACP spawn hints, polling guidance | Yes — verbose inline tutorials in cron/session_status summaries |
| 3   | ## Tool Call Style               | ~900               | ~225          | Narration guidance, approval handling, exec commands                         | Slightly                                                        |
| 4   | ## Safety                        | ~500               | ~125          | Safety rules (Anthropic constitution-inspired)                               | No                                                              |
| 5   | ## OpenClaw CLI Quick Reference  | ~350               | ~88           | Gateway subcommands, help advice                                             | Slightly                                                        |
| 6   | ## Skills (mandatory)            | ~5,000–30,000      | ~1,250–7,500  | Skills catalog in XML format with names, descriptions, locations             | Variable — already has compact mode                             |
| 7   | ## Memory                        | ~500–1,000         | ~125–250      | Memory search/citations guidance (from plugin)                               | No                                                              |
| 8   | ## OpenClaw Self-Update          | ~600               | ~150          | Gateway config/update actions, schema lookup                                 | Slightly                                                        |
| 9   | ## Model Aliases                 | ~200               | ~50           | Model alias mappings                                                         | No                                                              |
| 10  | ## Workspace                     | ~200               | ~50           | Working directory, sandbox paths                                             | No                                                              |
| 11  | ## Documentation                 | ~300               | ~75           | Docs paths, links                                                            | No                                                              |
| 12  | ## Sandbox                       | ~800 (conditional) | ~200          | Sandbox runtime info, elevated exec                                          | No                                                              |
| 13  | ## Authorized Senders            | ~100               | ~25           | Owner identity line                                                          | No                                                              |
| 14  | ## Current Date & Time           | ~50                | ~13           | Timezone                                                                     | No                                                              |
| 15  | ## Workspace Files (injected)    | ~100               | ~25           | Header note about Project Context                                            | No                                                              |
| 16  | ## Reply Tags                    | ~500               | ~125          | [[reply_to_current]] syntax                                                  | Slightly                                                        |
| 17  | ## Messaging                     | ~500               | ~125          | Routing guidance, message tool usage, channel hints                          | Yes — channel hints are per-channel already                     |
| 18  | ## Voice (TTS)                   | ~100 (conditional) | ~25           | TTS hint                                                                     | No                                                              |
| 19  | ## Group Chat / Subagent Context | Variable           | Variable      | Extra system prompt injected                                                 | No                                                              |
| 20  | ## Reactions                     | ~300 (conditional) | ~75           | Reaction level guidance                                                      | No                                                              |
| 21  | ## Reasoning Format              | ~400 (conditional) | ~100          | Think/final tag format                                                       | No                                                              |
| 22  | # Project Context                | ~5,000–150,000     | ~1,250–37,500 | Bootstrap files (AGENTS.md, SOUL.md, etc.)                                   | No (user content)                                               |
| 23  | ## Silent Replies                | ~300               | ~75           | SILENT_REPLY_TOKEN rules                                                     | Slightly                                                        |
| 24  | ## Heartbeats                    | ~300               | ~75           | Heartbeat ack protocol                                                       | No                                                              |
| 25  | ## Runtime                       | ~200               | ~50           | Runtime info line (agent, host, model, channel)                              | No                                                              |

**Estimated total (full mode, no sandbox):** ~13,000–188,000 chars (~3,250–47,000 tokens)

The dominant cost is #22 (Project Context / bootstrap files) at up to 150K chars, and #6 (Skills) at up to 30K chars.

## 2. Bootstrap Injection

Source: `src/agents/workspace.ts` — `loadWorkspaceBootstrapFiles()`
Budget: `src/agents/pi-embedded-helpers/bootstrap.ts` — `buildBootstrapContextFiles()`

### Files injected

| File         | Default limit (chars) | Inject decision                                                              |
| ------------ | --------------------- | ---------------------------------------------------------------------------- |
| AGENTS.md    | 20,000                | Always (if exists)                                                           |
| SOUL.md      | 20,000                | Always (if exists)                                                           |
| TOOLS.md     | 20,000                | Always (if exists)                                                           |
| IDENTITY.md  | 20,000                | Always (if exists)                                                           |
| USER.md      | 20,000                | Always (if exists)                                                           |
| HEARTBEAT.md | 20,000                | Always (if exists); filtered to only this file in heartbeat lightweight mode |
| BOOTSTRAP.md | 20,000                | Only during initial setup (before setup completed)                           |
| MEMORY.md    | 20,000                | Always (if exists); prefers MEMORY.md over memory.md                         |

### Budget limits

- **Per-file max:** `agents.defaults.bootstrapMaxChars` — default 20,000 chars
- **Total max:** `agents.defaults.bootstrapTotalMaxChars` — default 150,000 chars
- **Truncation strategy:** 70% head + 20% tail with ellipsis marker
- **Subagent/cron filtering:** `filterBootstrapFilesForSession()` keeps only AGENTS.md, TOOLS.md, SOUL.md, IDENTITY.md, USER.md

### Injection path

1. `resolveBootstrapContextForRun()` in `src/agents/bootstrap-files.ts` loads and filters files
2. `buildBootstrapContextFiles()` enforces per-file and total char budgets
3. Result passed as `contextFiles` to `buildAgentSystemPrompt()`
4. Rendered under `# Project Context` section (lines 601–624)

## 3. Tool Schemas

Source: `src/agents/tools/` — individual tool files
Assembly: `src/agents/pi-tools.ts` — `createOpenClawCodingTools()`
Schema normalization: `src/agents/pi-tools.schema.ts`

### Top-5 heaviest tools by schema size

| Tool           | Properties | Est. Schema JSON (chars) | File                                                |
| -------------- | ---------- | ------------------------ | --------------------------------------------------- |
| message        | ~70+       | ~10,000–15,000           | `src/agents/tools/message-tool.ts` (805 LOC)        |
| nodes          | ~40+       | ~3,000–5,000             | `src/agents/tools/nodes-tool.ts` (867 LOC)          |
| pdf            | ~30+       | ~3,000–4,000             | `src/agents/tools/pdf-tool.ts` (561 LOC)            |
| image_generate | ~25+       | ~2,000–3,000             | `src/agents/tools/image-generate-tool.ts` (651 LOC) |
| cron           | ~15        | ~2,000–3,000             | `src/agents/tools/cron-tool.ts` (541 LOC)           |

**Estimated total tool schema size:** ~25,000–35,000 chars (~6,250–8,750 tokens)

### message tool schema breakdown

The message tool aggregates parameters from all channels into one flat schema:

- **Routing:** channel, target, targets, accountId, dryRun (5 props)
- **Send:** message, effectId, effect, media, filename, buffer, contentType, mimeType, caption, path, filePath, replyTo, threadId, asVoice, silent, quoteText, bestEffort, gifPlayback, forceDocument, asDocument, interactive (21 props)
- **Reaction:** messageId, message_id, emoji, remove, targetAuthor, targetAuthorUuid, groupId (7 props)
- **Fetch:** limit, pageSize, pageToken, before, after, around, fromMe, includeArchived (8 props)
- **Poll:** pollId, pollOptionId, pollOptionIds, pollOptionIndex, pollOptionIndexes + shared creation params (10+ props)
- **Channel target:** channelId, chatId, channelIds, memberId, memberIdType, guildId, userId, openId, unionId, authorId, authorIds, roleId, roleIds, participant, includeMembers, members, scope, kind (18 props)
- **Sticker:** emojiName, stickerId, stickerName, stickerDesc, stickerTags (5 props)
- **Thread:** threadName, autoArchiveMin, appliedTags (3 props)
- **Event:** query, eventName, eventType, startTime, endTime, desc, location, durationMin, until (9 props)
- **Moderation:** reason, deleteDays (2 props)
- **Gateway:** gatewayUrl, gatewayToken, timeoutMs (3 props)
- **Channel management:** name, type, parentId, topic, position, nsfw, rateLimitPerUser, categoryId, clearParent (9 props)
- **Presence:** activityType, activityName, activityUrl, activityState, status (5 props)
- **Channel-specific extras:** via `resolveChannelMessageToolSchemaProperties()` — additional per-channel props (variable)

Note: The message tool already does partial action filtering via `resolveMessageToolSchemaActions()` and capability-based `resolveIncludeInteractive()`, but the property schema groups (sticker, presence, channel management, etc.) are always included regardless of active channels.

## 4. Skills Injection

Source: `src/agents/skills/workspace.ts` — `formatSkillsForPrompt()` / `formatSkillsCompact()`

### What is injected

- XML-formatted catalog of available skills: `<available_skills>` with `<skill>` entries containing `<name>`, `<description>`, `<location>`
- Header text with instructions on how to use skills
- Compact mode: name + location only (no description) when full format exceeds budget

### Limits

| Limit                      | Default |
| -------------------------- | ------- |
| `maxSkillsInPrompt`        | 150     |
| `maxSkillsPromptChars`     | 30,000  |
| `maxSkillFileBytes`        | 256,000 |
| `maxCandidatesPerRoot`     | 300     |
| `maxSkillsLoadedPerSource` | 200     |

### Skill sources (precedence order, last wins)

1. Extra dirs (config + plugin skill dirs)
2. Bundled skills (`openclaw-bundled`)
3. Managed skills (`~/.openclaw/skills`)
4. Personal agents skills (`~/.agents/skills`)
5. Project agents skills (`<workspace>/.agents/skills`)
6. Workspace skills (`<workspace>/skills`)

Path compaction: home directory prefix replaced with `~` (~5-6 tokens saved per skill path).

## 5. Session Startup Message

Source: `src/auto-reply/reply/session-reset-prompt.ts` — line 4

**Exact text:**

```
A new session was started via /new or /reset. Run your Session Startup sequence - read the required files before responding to the user. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.
```

**Problem:** This message tells the agent to "read the required files" — but bootstrap files (AGENTS.md, SOUL.md, etc.) are already injected into the system prompt via `# Project Context`. The agent re-reads them via tool calls, wasting 5+ tool calls and ~15,000+ tokens per session start.

### Post-compaction refresh

Source: `src/auto-reply/reply/post-compaction-context.ts`

After context compaction, a similar message instructs the agent to re-read bootstrap files, extracting critical sections from AGENTS.md. This is a separate but related issue.

## 6. Static vs Dynamic Classification

| Component                           | Classification | Reason                                                    |
| ----------------------------------- | -------------- | --------------------------------------------------------- |
| Identity line                       | STATIC         | Never changes                                             |
| ## Tooling (tool list + summaries)  | STATIC         | Changes only when config/tools change (restart)           |
| ## Tool Call Style                  | STATIC         | Hardcoded text                                            |
| ## Safety                           | STATIC         | Hardcoded text                                            |
| ## CLI Quick Reference              | STATIC         | Hardcoded text                                            |
| ## Skills catalog                   | STATIC         | Changes only on skill add/remove (restart)                |
| ## Memory guidance                  | STATIC         | Plugin-provided, stable                                   |
| ## Self-Update                      | STATIC         | Hardcoded text                                            |
| ## Model Aliases                    | STATIC         | Changes on config reload                                  |
| ## Workspace dir                    | **DYNAMIC**    | Can differ per session (sandbox paths)                    |
| ## Documentation                    | STATIC         | Hardcoded text                                            |
| ## Sandbox info                     | **DYNAMIC**    | Per-session sandbox state                                 |
| ## Authorized Senders               | STATIC         | Changes on config reload                                  |
| ## Current Date & Time              | **DYNAMIC**    | Timezone per-session                                      |
| ## Workspace Files header           | STATIC         | Hardcoded text                                            |
| ## Reply Tags                       | STATIC         | Hardcoded text                                            |
| ## Messaging (channel options)      | **DYNAMIC**    | `messageChannelOptions` varies, channel hints per-session |
| ## Voice (TTS)                      | **DYNAMIC**    | Per-session TTS hint                                      |
| ## Group Chat Context               | **DYNAMIC**    | Per-session extra system prompt                           |
| ## Reactions                        | **DYNAMIC**    | Per-session reaction level                                |
| ## Reasoning Format                 | **DYNAMIC**    | Per-session reasoning config                              |
| # Project Context (bootstrap files) | **DYNAMIC**    | File contents can change between requests                 |
| ## Silent Replies                   | STATIC         | Hardcoded text                                            |
| ## Heartbeats                       | **DYNAMIC**    | Heartbeat prompt from config (but stable)                 |
| ## Runtime line                     | **DYNAMIC**    | Agent ID, host, model, channel, capabilities              |

### Current prompt structure problem

Static and dynamic sections are **interleaved** throughout the prompt. For example:

- Static (Tooling) → Static (Safety) → Static (Skills) → ... → **Dynamic** (Workspace dir) → Static (Docs) → **Dynamic** (Sandbox) → Static (Reply Tags) → **Dynamic** (Messaging hints) → ... → **Dynamic** (Project Context) → Static (Silent Replies) → **Dynamic** (Runtime)

This interleaving means Anthropic's prompt cache can only reuse the prefix up to the first dynamic section, yielding an estimated **~10% cache hit rate** (only the identity line and initial static sections before the first dynamic element).

### Optimal structure

All STATIC sections should be grouped first, followed by all DYNAMIC sections. This would enable **>80% prompt cache hit rate** on the static prefix.

---

## 7. Changes Applied (Before/After)

### Summary of optimizations

| Change                                               | Commit                                                             | Impact                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Channel instructions filtered by configured channels | `prompt: inject channel instructions only for configured channels` | `messageChannelOptions` now lists only configured channels instead of all ~100 registered channels   |
| `promptTools` whitelist config                       | `prompt: add promptTools whitelist config option`                  | New `agents.defaults.promptTools` config filters tool descriptions in prompt                         |
| Message tool schema filtered by active actions       | `tools: filter message schema params by active channels`           | Property groups (sticker, presence, moderation, etc.) only included when relevant actions are active |
| Shortened verbose tool descriptions                  | `prompt: shorten verbose tool descriptions`                        | Removed inline tutorials from cron, session_status, sessions_spawn, agents_list summaries            |
| Bootstrap double-read fixed                          | `session: fix bootstrap double-read on startup`                    | Session reset prompt tells agent NOT to re-read bootstrap files (saves ~5 tool calls per session)    |
| Static/dynamic prompt split                          | `cache: split static and dynamic prompt blocks`                    | All static sections grouped first as cacheable prefix, dynamic sections after                        |

### Before/After Comparison

| Component                             | Before (est. tokens)              | After (est. tokens)   | Reduction                                                      |
| ------------------------------------- | --------------------------------- | --------------------- | -------------------------------------------------------------- |
| cron tool summary                     | ~60                               | ~10                   | ~83%                                                           |
| session_status tool summary           | ~35                               | ~18                   | ~49%                                                           |
| sessions_spawn tool summary (ACP)     | ~45                               | ~12                   | ~73%                                                           |
| agents_list tool summary (ACP)        | ~25                               | ~12                   | ~52%                                                           |
| message tool schema (Telegram-only)   | ~3,500                            | ~2,000                | ~43% (sticker/presence/moderation/channel-mgmt groups removed) |
| messageChannelOptions (Telegram-only) | ~200 (all channels listed)        | ~10 (just "telegram") | ~95%                                                           |
| Session startup tool calls            | ~5 calls, ~15,000 tokens          | 0 calls               | 100%                                                           |
| Prompt cache hit rate                 | ~10% (interleaved static/dynamic) | ~80%+ (static prefix) | 8x improvement                                                 |

### New prompt section order

**STATIC prefix (cacheable):**

1. Identity line
2. Tooling (tool list + summaries + ACP guidance)
3. Tool Call Style
4. Safety
5. CLI Quick Reference
6. Skills
7. Memory
8. Self-Update
9. Model Aliases
10. Documentation
11. Authorized Senders
12. Reply Tags
13. Silent Replies
14. Workspace Files header

**DYNAMIC suffix (per-session):** 15. Workspace dir + guidance 16. Sandbox info (conditional) 17. Current Date & Time 18. Messaging + channel hints 19. Voice (TTS) 20. Group Chat / Subagent Context 21. Reactions (conditional) 22. Reasoning Format (conditional) 23. Project Context (bootstrap files) 24. Heartbeats (conditional) 25. Runtime line

### New config options

```jsonc
// openclaw.json
{
  "agents": {
    "defaults": {
      // Only describe these tools in the prompt; others remain callable but undescribed
      "promptTools": ["read", "write", "exec", "cron", "message", "web_search", "web_fetch"],
    },
  },
}
```
