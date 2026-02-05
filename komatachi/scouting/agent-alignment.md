# Agent Alignment Component Scouting Report

## Summary

The agent alignment component in OpenClaw manages how agents behave, what tools they have access to, and how they respond to users. This includes:

1. **System Prompt Generation** - Builds comprehensive system prompts that define agent personality, capabilities, workspace context, and behavioral guidelines
2. **Tool Policy Management** - Controls which tools agents can access through profiles (minimal, coding, messaging, full) and allow/deny lists
3. **Workspace Bootstrap Files** - Manages user-editable context files (AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md, USER.md, etc.) that are injected into the system prompt
4. **External Content Security** - Provides guardrails for handling untrusted content from external sources (emails, webhooks) with prompt injection detection
5. **Plugin Hooks System** - Enables plugins to modify agent behavior through lifecycle hooks (before_agent_start, before_tool_call, etc.)
6. **Skills Configuration** - Manages skill eligibility, invocation policies, and frontmatter parsing for agent capabilities
7. **Persona Management** - Supports SOUL.md for agent persona/tone, with a hook mechanism (soul-evil) for persona variants

## File Index

Key source files organized by distillation target. Cross-references to ROADMAP.md phases.
See detailed table below for complete listing with line counts and test files.

### System prompt (-> Phase 3.1: System Prompt)
src/agents/system-prompt.ts             - Core prompt builder: 20+ sections (tooling, skills, memory, messaging, sandbox, etc.)
src/agents/system-prompt-params.ts      - System prompt parameter building helpers
src/agents/pi-embedded-runner/system-prompt.ts - Embedded runner system prompt wrapper

### Tool policy (-> Phase 3.2: Tool Policy)
src/agents/tool-policy.ts               - Tool profile resolution (minimal/coding/messaging/full) and policy expansion
src/config/types.tools.ts               - Tool configuration types: policy, exec, media understanding

### Workspace bootstrap (-> Phase 3.3: Workspace Bootstrap)
src/agents/workspace.ts                 - Bootstrap file management: AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md, USER.md
src/agents/pi-embedded-helpers/bootstrap.ts - Bootstrap context file building and truncation for prompt injection
src/config/types.agent-defaults.ts      - Agent defaults config types (model, heartbeat, sandbox, compaction)
src/config/zod-schema.agent-defaults.ts - Zod validation schema for agent defaults
src/config/types.agents.ts              - Agent config types (name, model, capabilities)

### Security (reference)
src/security/external-content.ts        - Untrusted content handling: prompt injection detection, safe wrapping

### Skills (out of scope - dropped per "no plugin hooks" decision)
src/agents/skills/config.ts             - Skill eligibility and config resolution
src/agents/skills/frontmatter.ts        - Skill frontmatter parsing and metadata resolution
src/agents/skills/types.ts              - Skill type definitions

### Plugin system (out of scope - dropped entirely)
src/plugins/types.ts                    - Plugin type definitions: hook types, handler maps
src/plugins/hooks.ts                    - Plugin hook runner: priority ordering, error handling
src/hooks/soul-evil.ts                  - SOUL_EVIL.md persona swap hook

## Source Files with Line Counts

| File | Lines | Description |
|------|-------|-------------|
| `/home/user/Komatachi/src/agents/system-prompt.ts` | 591 | Core system prompt builder with sections for tooling, skills, memory, messaging, sandbox, etc. |
| `/home/user/Komatachi/src/plugins/types.ts` | 528 | Plugin type definitions including hook types and handler maps |
| `/home/user/Komatachi/src/plugins/hooks.ts` | 460 | Plugin hook runner with priority ordering and error handling |
| `/home/user/Komatachi/src/config/types.tools.ts` | 450 | Tool configuration types including policy, exec, media understanding |
| `/home/user/Komatachi/src/agents/workspace.ts` | 288 | Workspace bootstrap file management (AGENTS.md, SOUL.md, etc.) |
| `/home/user/Komatachi/src/config/types.agent-defaults.ts` | 262 | Agent defaults config types (model, heartbeat, sandbox, compaction) |
| `/home/user/Komatachi/src/hooks/soul-evil.ts` | 249 | SOUL_EVIL.md persona swap hook logic |
| `/home/user/Komatachi/src/agents/tool-policy.ts` | 234 | Tool profile resolution and policy expansion |
| `/home/user/Komatachi/src/agents/pi-embedded-helpers/bootstrap.ts` | 202 | Bootstrap context file building and truncation |
| `/home/user/Komatachi/src/security/external-content.ts` | 178 | Security utilities for untrusted external content |
| `/home/user/Komatachi/src/config/zod-schema.agent-defaults.ts` | 172 | Zod validation schema for agent defaults |
| `/home/user/Komatachi/src/agents/skills/config.ts` | 153 | Skill eligibility and config resolution |
| `/home/user/Komatachi/src/agents/skills/frontmatter.ts` | 139 | Skill frontmatter parsing and metadata resolution |
| `/home/user/Komatachi/src/agents/system-prompt-params.ts` | 105 | System prompt parameter building helpers |
| `/home/user/Komatachi/src/agents/skills/types.ts` | 87 | Skill type definitions |
| `/home/user/Komatachi/src/agents/pi-embedded-runner/system-prompt.ts` | 81 | Embedded runner system prompt wrapper |
| `/home/user/Komatachi/src/config/types.agents.ts` | 79 | Agent config types |
| `/home/user/Komatachi/src/agents/pi-embedded-helpers/types.ts` | 3 | Type exports for embedded helpers |

**Total Lines of Code: 4,261**

## Existing Test Files

| Test File | Lines |
|-----------|-------|
| `/home/user/Komatachi/src/agents/system-prompt.test.ts` | 372 |
| `/home/user/Komatachi/src/hooks/soul-evil.test.ts` | 254 |
| `/home/user/Komatachi/src/security/external-content.test.ts` | 210 |
| `/home/user/Komatachi/src/agents/system-prompt-params.test.ts` | 106 |
| `/home/user/Komatachi/src/agents/tool-policy.plugin-only-allowlist.test.ts` | 51 |
| `/home/user/Komatachi/src/hooks/bundled/soul-evil/handler.test.ts` | 48 |
| `/home/user/Komatachi/src/agents/tool-policy.test.ts` | 29 |
| `/home/user/Komatachi/src/agents/skills/frontmatter.test.ts` | 20 |

**Existing Test Files: 8**
**Total Test Lines: 1,090**

## Complexity Assessment: HIGH

### Reasoning:

1. **Multi-layered prompt construction**: The system prompt builder (`system-prompt.ts`) has 591 lines with 20+ distinct sections, conditional logic based on prompt mode (full/minimal/none), and complex parameter handling for tools, skills, sandbox, reactions, and more.

2. **Plugin hook architecture**: The hooks system involves multiple event types (14 hook names), priority ordering, both sync and async handlers, and result merging for modifying hooks. This requires careful coordination.

3. **Tool policy resolution**: Multiple layers of policy sources (profiles, allow/deny lists, plugin groups, agent-specific, provider-specific) must be resolved correctly with proper precedence.

4. **Security-sensitive code**: The external content handling has prompt injection detection patterns and security boundaries that must work correctly to prevent attacks.

5. **Workspace file injection**: Multiple bootstrap files with truncation logic, missing file handling, subagent filtering, and SOUL.md persona guidance.

6. **Cross-cutting concerns**: Agent alignment touches many areas - configuration, plugins, security, sessions, channels - requiring understanding of the broader system.

7. **Dynamic behavior**: Features like soul-evil hook, reaction guidance, reasoning tags, and elevated mode introduce runtime behavioral variations.

## Estimated Tests Required

Based on the complexity and current coverage gaps:

| Area | Current | Estimated Needed | Gap |
|------|---------|------------------|-----|
| System prompt generation | ~25 tests | 50 tests | +25 |
| Tool policy resolution | ~5 tests | 25 tests | +20 |
| Workspace bootstrap | ~0 tests | 20 tests | +20 |
| External content security | ~8 tests | 20 tests | +12 |
| Plugin hooks | ~0 tests | 30 tests | +30 |
| Skills config/frontmatter | ~2 tests | 15 tests | +13 |
| Soul-evil hook | ~10 tests | 15 tests | +5 |
| Agent defaults validation | ~0 tests | 15 tests | +15 |
| Integration tests | ~0 tests | 20 tests | +20 |

**Total Estimated Tests Needed: ~210 tests**
**Currently Existing: ~50 tests**
**Gap: ~160 additional tests**

### Priority Test Areas:

1. **System prompt sections** - Each section (tooling, skills, memory, messaging, sandbox, etc.) needs isolated tests
2. **Tool policy edge cases** - Group expansion, plugin groups, profile resolution, allow/deny precedence
3. **External content security** - Prompt injection patterns, boundary markers, safe wrapping
4. **Plugin hooks** - Priority ordering, result merging, error handling, sync vs async
5. **Workspace file handling** - Missing files, truncation, subagent filtering, SOUL.md detection
6. **Agent defaults validation** - Schema validation, default values, nested config paths
