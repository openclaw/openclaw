# TASK_05: Config Schema & Registration

<!-- SUMMARY: Defines the Zod config schema and registers telegram-userbot as a recognized channel in OpenClaw -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~15k                |
| **Priority**    | P0                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 2                   |
| **Wave**        | 1                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                   |
| --------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §2.1 Key Architectural Decision, §2.2 Why Separate Channel |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §5 Configuration Schema, §6 Channel Registration           |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-05                                                    |

## Task Dependency Tree

```
TASK-05 (Config Schema) ←── you are here
   │
   ├──► TASK-06 (Plugin Entry) — uses config schema
   └──► TASK-13 (CLI Setup) — validates config input
```

## Description

Define the Zod config schema for `channels.telegram-userbot` and ensure the channel is recognized by OpenClaw's channel system. This involves:

1. Create a Zod schema matching the design doc (apiId, apiHash, allowFrom, rateLimit, reconnect, capabilities)
2. Convert to JSON Schema via `buildChannelConfigSchema()` for the plugin manifest
3. Register `"telegram-userbot"` in the channel system (via extension registration, similar to how Discord/IRC do it)
4. Define channel meta (label, blurb, docsPath, systemImage)

**Business value:** Makes telegram-userbot a first-class channel in OpenClaw that can be configured, enabled, and managed through standard channel commands.

---

## Context

### Related Files (from codebase research)

| File                                      | Purpose                                            | Patterns to Follow                                                                         |
| ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/config/zod-schema.core.ts`           | Core channel Zod schemas (Telegram, Discord, etc.) | Schema structure, shared primitives (DmConfigSchema, AllowFrom patterns)                   |
| `extensions/irc/src/config-schema.ts`     | IRC config schema example                          | Extension config schema pattern                                                            |
| `src/channels/plugins/config-schema.ts`   | `buildChannelConfigSchema()` helper                | Convert Zod → JSON Schema                                                                  |
| `src/channels/registry.ts`                | CHAT_CHANNEL_ORDER, CHAT_CHANNEL_META              | Channel registration (note: extensions don't add to this array — they register via plugin) |
| `extensions/discord/openclaw.plugin.json` | Plugin manifest with configSchema                  | Manifest structure                                                                         |
| `extensions/line/package.json`            | LINE package.json with openclaw.channel metadata   | Extension package.json pattern                                                             |
| `src/channels/dock.ts`                    | Channel dock system                                | How extension docks are auto-built                                                         |
| `src/plugin-sdk/index.ts`                 | Plugin SDK exports                                 | Available schema builders and types                                                        |

### Code Dependencies

- `zod` (^4.3.6) — config schema definition
- `openclaw/plugin-sdk` — `buildChannelConfigSchema`, `DmConfigSchema`, shared primitives

---

## Goals

1. Zod schema for `channels.telegram-userbot` with all config fields
2. Plugin manifest (`openclaw.plugin.json`) with JSON Schema
3. Channel meta with label, blurb, docsPath, systemImage
4. Extension package.json with openclaw channel metadata
5. Config validation: apiId + apiHash required when section is present, rest optional with defaults

---

## Acceptance Criteria

**AC-1: Schema validation — valid config**

- Given: Config with `{ apiId: 14858133, apiHash: "abc123" }`
- When: Zod schema parses the config
- Then: Parsing succeeds with defaults applied for optional fields

**AC-2: Schema validation — missing required fields**

- Given: Config with `{ apiId: 14858133 }` (missing apiHash)
- When: Zod schema parses the config
- Then: Parsing fails with descriptive error

**AC-3: Schema validation — full config**

- Given: Full config with rateLimit, reconnect, capabilities, allowFrom
- When: Zod schema parses the config
- Then: All fields are correctly typed and defaults are overridden

**AC-4: Channel missing = disabled**

- Given: No `channels.telegram-userbot` section in config
- When: Plugin checks if channel is configured
- Then: Channel is treated as disabled (not an error)

**AC-5: Channel meta**

- Given: Plugin is registered
- When: `openclaw channels list` is run
- Then: Shows "Telegram (User)" with correct blurb and docs path

**AC-6: Config schema in manifest**

- Given: `openclaw.plugin.json` with configSchema
- When: Plugin loader validates the manifest
- Then: Schema is accepted

---

## Dependencies

**Depends on:**

- None (standalone config/registration task)

**Blocks:**

- TASK-06 (Plugin Entry) — uses config schema for validation, meta for plugin
- TASK-13 (CLI Setup) — validates user input against schema

---

## Files to Change

| Action | File                                                    | Scope                           |
| ------ | ------------------------------------------------------- | ------------------------------- |
| CREATE | `extensions/telegram-userbot/src/config-schema.ts`      | Zod schema + JSON schema export |
| CREATE | `extensions/telegram-userbot/openclaw.plugin.json`      | Plugin manifest                 |
| CREATE | `extensions/telegram-userbot/package.json`              | Extension package metadata      |
| CREATE | `extensions/telegram-userbot/src/config-schema.test.ts` | Schema validation tests         |

---

## Risks & Mitigations

| Risk                                   | Likelihood | Impact | Mitigation                                                |
| -------------------------------------- | ---------- | ------ | --------------------------------------------------------- |
| Schema incompatible with config loader | Low        | Medium | Test with real config loading path                        |
| Zod version mismatch                   | Low        | Low    | Use same Zod version as main package                      |
| Channel ID conflict                    | Low        | High   | Verify "telegram-userbot" is unique across all extensions |

---

## Out of Scope

- Actually reading/writing config files (TASK-06 config adapter handles that)
- Setup wizard prompts (TASK-13)
- Channel-specific Zod helpers beyond the schema itself

---

## Testing

| Type | Description                                         | File                                                    |
| ---- | --------------------------------------------------- | ------------------------------------------------------- |
| Unit | Valid config parses successfully                    | `extensions/telegram-userbot/src/config-schema.test.ts` |
| Unit | Missing required fields fail validation             | `extensions/telegram-userbot/src/config-schema.test.ts` |
| Unit | Default values applied correctly                    | `extensions/telegram-userbot/src/config-schema.test.ts` |
| Unit | Full config with all options                        | `extensions/telegram-userbot/src/config-schema.test.ts` |
| Unit | buildChannelConfigSchema produces valid JSON Schema | `extensions/telegram-userbot/src/config-schema.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                              |
| -------------- | ------ | ---------------------------------- |
| Research       | ~3k    | Study existing config schemas      |
| Implementation | ~8k    | Zod schema, manifest, package.json |
| Testing        | ~4k    | Validation tests                   |
| **Total**      | ~15k   | Focused schema task                |

---

## Subtasks

- [ ] 1.  Create `config-schema.ts` with Zod schema (apiId, apiHash, allowFrom, rateLimit, reconnect, capabilities)
- [ ] 2.  Export typed config type from schema
- [ ] 3.  Export JSON Schema via `buildChannelConfigSchema()`
- [ ] 4.  Create `openclaw.plugin.json` manifest
- [ ] 5.  Create `package.json` with openclaw channel metadata
- [ ] 6.  Write unit tests for schema validation (valid, invalid, defaults)
