# Feature: Leo Agent Identity & Configuration

## Priority: 1 (Foundation)

## Status: Spec Written

## Description

Configure OpenClaw's agent as "Leo" -- Ali's personal AI chief of staff. This
feature builds three pieces that plug into OpenClaw's existing systems:

1. **Leo identity config** (`LeoIdentityConfig`) -- a Zod schema for the
   `leo` key in `openclaw.json` that holds identity fields (name, role,
   owner_name), per-org credentials, and tool policy overrides.

2. **System prompt builder** (`buildLeoSystemPrompt`) -- generates Leo's
   persona block (identity line, org context summary, communication style
   guidelines, approval rules) from the validated config. The output is
   injected as `extraSystemPrompt` into OpenClaw's existing
   `buildAgentSystemPrompt`.

3. **Leo tool registry** (`registerLeoTools`) -- registers Leo-specific
   tool definitions (people, gmail, calendar, slack_read, asana, monday,
   github, briefing) into OpenClaw's tool pipeline with correct policy
   defaults (gmail.send and calendar.create require approval).

All three integrate through OpenClaw's existing extension points -- no
upstream source modifications.

## Acceptance Criteria

1. `parseLeoConfig(valid)` returns a validated `LeoIdentityConfig` object
2. `parseLeoConfig(invalid)` throws a `ZodError` with descriptive path
3. `parseLeoConfig(minimal)` succeeds with only required fields (identity + at least one org with google_workspace)
4. `buildLeoSystemPrompt(config)` output contains "You are Leo, Ali's personal AI chief of staff"
5. `buildLeoSystemPrompt(config)` output lists all configured orgs with their services
6. `buildLeoSystemPrompt(config)` output includes communication style directives
7. `buildLeoSystemPrompt(config)` output mentions approval-required tools
8. `registerLeoTools(config)` returns tool definitions for all 8 tool namespaces
9. `registerLeoTools(config)` marks `gmail.send` and `calendar.create` as requiring approval
10. `registerLeoTools(config)` omits tool namespaces whose org credentials are missing (e.g., no monday config -> no monday tools)

## Test Cases

| #   | Test                                 | Input                                                | Expected Output                                                                        |
| --- | ------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Valid full config parses             | Config with identity + 4 orgs + all services         | Returns LeoIdentityConfig object                                                       |
| 2   | Minimal config parses                | Config with identity + 1 org (google_workspace only) | Returns LeoIdentityConfig, optional services undefined                                 |
| 3   | Missing identity rejects             | Config without identity block                        | ZodError at path "identity"                                                            |
| 4   | Missing org google_workspace rejects | Org entry without google_workspace                   | ZodError at path "orgs.<name>.google_workspace"                                        |
| 5   | Extra unknown keys stripped          | Config with extra top-level key "foo"                | Parses without "foo" in output                                                         |
| 6   | System prompt identity line          | Full config                                          | Contains "You are Leo, Ali's personal AI chief of staff"                               |
| 7   | System prompt lists orgs             | Config with edubites + zenloop                       | Contains "edubites" and "zenloop" org summaries                                        |
| 8   | System prompt with single org        | Config with only protaige                            | Contains "protaige", does not mention edubites/zenloop                                 |
| 9   | System prompt communication style    | Any valid config                                     | Contains "concise" and "actionable" directives                                         |
| 10  | System prompt approval rules         | Config with gmail.send approval                      | Contains "gmail.send" and "approval" in output                                         |
| 11  | Tool registry returns all namespaces | Full config with all services                        | Returns tools for people, gmail, calendar, slack_read, asana, monday, github, briefing |
| 12  | Tool registry omits unconfigured     | Config with no monday credentials                    | No monday.\* tools in result                                                           |
| 13  | Tool registry approval policy        | Full config                                          | gmail.send and calendar.create have requireApproval: true                              |
| 14  | Tool registry tool definitions valid | Full config                                          | Each tool has name, description, and parameters (Zod schema)                           |
| 15  | Empty orgs rejects                   | Config with identity but empty orgs object           | ZodError - orgs must have at least 1 entry                                             |

## Dependencies

- None (this is a foundation feature, alongside People Index)

## Files

### New Files

- `src/leo/leo-config.ts` -- LeoIdentityConfig Zod schema and parser (`parseLeoConfig`)
- `src/leo/leo-config.test.ts` -- Unit tests for config validation
- `src/leo/leo-system-prompt.ts` -- `buildLeoSystemPrompt` function
- `src/leo/leo-system-prompt.test.ts` -- Unit tests for prompt builder
- `src/leo/leo-tool-registry.ts` -- `registerLeoTools` function + tool definitions
- `src/leo/leo-tool-registry.test.ts` -- Unit tests for tool registration
- `src/leo/types.ts` -- Shared TypeScript types exported from Zod schemas

### Integration Points (existing files, no modifications in this feature)

- `src/agents/system-prompt.ts` -- `buildAgentSystemPrompt` accepts `extraSystemPrompt` param (already supported)
- `src/config/types.openclaw.ts` -- `OpenClawConfig` has catch-all channel/plugin extension points
- `src/agents/identity.ts` -- Existing identity resolution used alongside Leo identity

## Notes

- The `src/leo/` directory is new. All Leo-specific code lives here to avoid polluting upstream OpenClaw source.
- `LeoIdentityConfig` is a standalone Zod schema (not merged into OpenClawSchema) -- it validates a separate `leo` section in openclaw.json or an independent leo.json config file.
- Credential values (tokens, secrets) are validated as non-empty strings by Zod but never logged or included in system prompts.
- The system prompt builder produces a string block; the caller is responsible for passing it as `extraSystemPrompt` to `buildAgentSystemPrompt`.
- Tool definitions follow OpenClaw's existing pattern: `{ name, description, parameters }` where parameters is a Zod schema. Actual tool handler implementations are NOT part of this feature -- they are built in their respective feature specs (02-gmail, 03-calendar, etc.).
- `registerLeoTools` returns stub tool definitions (name + description + parameter schema + policy). Handler functions are wired in by each feature's implementation task.
