# Context-Aware Sanitization

### OpenClaw · Feature Spec · v2.1

### Extension of: Transcript Sanitization Subagent for Session Memory + MCP Trust Tier

### Companion to: Input Validation Layers v2.3, Audit Trail Enhancement v2.2, Audit Alerting v2.3

---

## Changelog (v2 → v2.1)

| Issue                                                                                                              | Resolution                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `general` profile `auditVerbosityFloor` was `"standard"`; implementation has `"minimal"`                           | Corrected to `"minimal"`.                                                                   |
| `code-generation` schema strictness described as per-source with "strict on file path scope"; code is flat lenient | Updated to flat `"lenient"`. Per-source strictness for path scope is a future enhancement.  |
| `research` schema strictness described as "strict on source attribution"; code is flat lenient                     | Updated to flat `"lenient"`.                                                                |
| Sub-agent prompt variants described as `.txt` files in `prompts/`; code uses inline TypeScript constants           | Added implementation note. Target file structure retained as design intent.                 |
| Custom profile format listed as "YAML or JSON"; code accepts JSON only                                             | Updated Custom Profiles section and Config Surface to note YAML is not currently supported. |
| `context_profile_loaded` event field `profile` mismatched; implementation uses `contextProfile`                    | Updated event shape to use `contextProfile`.                                                |

## Changelog (v1 → v2)

| Issue                                                                                                                                                                           | Resolution                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec references "Stage 1 pre-filter" but the input validation spec defines parallel Stages 1A (syntactic) and 1B (schema)                                                       | Updated all references to specify which stage receives profile hints. Syntactic emphasis maps to Stage 1A. Schema strictness maps to Stage 1B.                                                             |
| `syntacticEmphasis.suppressRules` allows profiles to downgrade rules to flags-only, but the input validation spec's `twoPass.hardBlockRules` can re-promote them to hard blocks | Defined precedence: `hardBlockRules` wins. `suppressRules` only affects rules NOT in `hardBlockRules`. Added explicit operator note.                                                                       |
| Profile's `schemaStrictness: "lenient"` was undefined — what does lenient schema validation actually do?                                                                        | Defined: lenient mode allows extra top-level fields on transcripts and skips strict field-type checking on MCP results. Missing required fields still fail.                                                |
| Profile's `auditVerbosity` overrides the global `audit.verbosity` with no precedence rule                                                                                       | Defined: profile verbosity is a floor, not a ceiling. The global verbosity always wins if it's higher. Profile can raise verbosity for its context but never lower it below the operator's global setting. |
| Custom profile `subAgentPromptAppend` had no size limit                                                                                                                         | Added 4KB limit. Oversized prompt append fails at startup with clear error.                                                                                                                                |
| No interaction defined between profile `syntacticEmphasis.addRules` and the `RULE_TAXONOMY` constant                                                                            | Defined: `addRules` entries must exist in `RULE_TAXONOMY`. Unknown rule IDs fail at startup.                                                                                                               |
| Profile-specific frequency tracking weights not addressed                                                                                                                       | Defined: profiles can override frequency weights. Merged with global defaults at config load time.                                                                                                         |
| `context_profile_loaded` audit event existed in this spec but was never assigned a verbosity tier in the audit trail spec                                                       | Assigned to `minimal` tier — always emitted when audit is enabled. It's metadata, not content.                                                                                                             |
| No interaction between profile schema strictness and the input validation spec's discriminated union validation                                                                 | Defined: discriminated union validation is always strict regardless of profile. Lenient mode only affects extra-field tolerance, not type checking or discriminant matching.                               |
| Built-in profiles reference detection capabilities (PII, credential shapes) that map to semantic-only rule IDs but don't reference them by taxonomy ID                          | All profile emphasis now references specific `RULE_TAXONOMY` IDs.                                                                                                                                          |

---

## Summary

Extend the sanitization sub-agent to apply different inspection rules and
emphasis based on the agent's declared context and permission scope. Context
is declared by the operator in config (not derived at runtime from user input),
selects a static system prompt variant for the sub-agent, and is surfaced in
audit entries. A small set of built-in context profiles covers common deployment
patterns. Operators can define custom profiles for specialized deployments.

Context profiles modulate behavior at three points in the validation pipeline:

1. **Stage 1A (syntactic):** Which rule IDs are emphasized or suppressed
2. **Stage 1B (schema):** Strict vs. lenient field tolerance
3. **Stage 2 (semantic):** Which sub-agent prompt variant is used

Profiles do NOT disable stages or bypass validation. They tune emphasis
within stages that always run.

---

## Design Goals

- **Public deployment friendly.** Context profiles are pre-built and
  operator-selectable with a single config field. No prompt engineering required
  from the operator.
- **Static prompt variants only.** Context selection happens at config load time,
  not at runtime. The sub-agent never receives user-controlled context type input.
  This preserves the static prompt guarantee from the base architecture.
- **Least-privilege by default.** The default profile (`general`) applies the
  broadest restrictions. Operators opt into narrower, more permissive profiles
  explicitly.
- **Composable with input validation.** Context profiles feed emphasis hints
  into Stage 1A (syntactic pre-filter) and strictness settings into Stage 1B
  (schema validation) from the input validation spec.
- **Custom profiles are operator-owned and version-controlled.** No dynamic
  profile assembly from user input or external config at runtime.

---

## Architecture

```
Config loads
        ↓
resolveContextProfile(cfg)
  ├── built-in profile selected (general | customer-service |
  │   code-generation | research | admin)
  └── custom profile loaded from declared file path (validated, ≤ 4KB append)
        ↓
Profile selects:
  - static sub-agent system prompt variant (Stage 2)
  - syntactic rule emphasis set (Stage 1A)
  - schema strictness level (Stage 1B)
  - frequency weight overrides
  - audit verbosity floor
        ↓
Profile is frozen for the lifetime of the agent session.
User input never changes the active profile.
```

### Integration with Input Validation Pipeline

```
Input arrives
        ↓
Stage 1 (parallel):
  ┌──────────────────────────────────┬─────────────────────────────────────┐
  │ Stage 1A: Syntactic Filter       │ Stage 1B: Schema Validation         │
  │ ← profile.syntacticEmphasis      │ ← profile.schemaStrictness          │
  │   (addRules, suppressRules)      │   ("strict" | "lenient")            │
  └──────────────┬───────────────────┴──────────────┬──────────────────────┘
                 └──────────── merge ───────────────┘
                              ↓
  Frequency scoring ← profile.frequencyWeightOverrides
                              ↓
  Two-pass gating (profile does NOT affect gating logic)
                              ↓
Stage 2: Semantic Sub-Agent
  ← profile selects prompt variant (base.txt + profile.txt + append)
  ← syntactic flags passed as hints (unchanged from input validation spec)
```

---

## Built-In Context Profiles

### `general` (default)

Broadest restrictions. Suitable for any deployment where the agent's task
scope is not narrowly defined.

**Syntactic emphasis (Stage 1A):**

- All rules at default weight — no additions, no suppressions

**Schema strictness (Stage 1B):**

- Strict: extra fields fail, types enforced, discriminated unions required

**Semantic emphasis (Stage 2):**

- Flags any instruction-like content
- Flags role-switching attempts
- Flags credential-shaped content (`credential.api-key-pattern`,
  `credential.password-pattern`, `credential.env-var-pattern`)
- Flags scope creep in MCP results (`scope-creep.permission-escalation`,
  `scope-creep.cross-agent-reference`)

**Frequency weights:** Global defaults (no overrides)

**Audit verbosity floor:** `minimal`

### `customer-service`

Narrowed for agents handling support interactions. Expects structured ticket
data, customer records, knowledge base lookups.

**Syntactic emphasis (Stage 1A):**

- `addRules`: none (syntactic rules are context-independent)
- `suppressRules`: none

**Schema strictness (Stage 1B):**

- Strict on MCP results (tool responses should match declared schemas)
- Lenient on transcript content (customer messages may contain irregular
  formatting that triggers false positives on structural checks)

> **Implementation note:** Schema strictness is per-source, not global.
> `customer-service` applies strict to MCP, lenient to transcript. This
> requires `schemaStrictness` to accept a per-source object in addition
> to a flat string. See Config Surface.

**Semantic emphasis (Stage 2):**

- Extra emphasis on: `credential.api-key-pattern`, `credential.password-pattern`,
  `credential.env-var-pattern` in tool results (customer data must not leak creds)
- Reduced emphasis on: `injection.role-switch-only` in transcript content
  (customers sometimes use phrases like "act as" in legitimate requests)
- Flags results that include fields beyond customer/ticket scope
  (`scope-creep.permission-escalation`)

**Frequency weights:**

- `credential.*`: 15 (elevated from default 0 — credentials in support context
  are highly suspicious)

**Audit verbosity floor:** `high` (compliance-oriented)

### `code-generation`

Narrowed for agents assisting with software development. Expects code, file
system results, git output, test runner output.

**Syntactic emphasis (Stage 1A):**

- `addRules`: none at syntactic level — code injection detection requires intent
  analysis (semantic)
- `suppressRules`: `structural.encoding-trick` (base64 content is legitimate in
  code contexts — images, encoded config, test fixtures)

> **Operator note:** `structural.encoding-trick` is suppressed to flags-only,
> not removed. If it appears in `twoPass.hardBlockRules`, the hard block takes
> precedence. Adjust `hardBlockRules` if you want the suppression to take effect
> in two-pass mode.

**Schema strictness (Stage 1B):**

- `"lenient"` — extra fields produce a flag, not a fail (code output has highly
  variable structure). Missing required fields and type mismatches still fail.

**Semantic emphasis (Stage 2):**

- Reduced emphasis on: code-like syntax in content (legitimate)
- Extra emphasis on: `injection.ignore-previous` and `injection.system-override`
  via code comments (`# ignore...`, `// SYSTEM:`, `<!-- system -->`),
  shell command injection patterns, path traversal in file results
- Flags results containing `credential.env-var-pattern` or credential file
  references
- Flags references to agent config or memory files
  (`scope-creep.cross-agent-reference`)

**Frequency weights:**

- `structural.encoding-trick`: 1 (reduced from default 5 — base64 is expected)
- `credential.*`: 12 (elevated — credentials in code output are suspicious)

**Audit verbosity floor:** `standard`

### `research`

For agents performing information gathering, summarization, and analysis.
High volume of external content.

**Syntactic emphasis (Stage 1A):**

- `suppressRules`: `injection.role-switch-only` (research content frequently
  contains phrases like "you are a" in quoted academic/journalistic material)

**Schema strictness (Stage 1B):**

- `"lenient"` — extra fields produce a flag, not a fail (web content and document
  excerpts have variable structure). Missing required fields and type mismatches
  still fail.

**Semantic emphasis (Stage 2):**

- Reduced emphasis on: instruction-like phrases within detected quotation
  boundaries (common in research material)
- Extra emphasis on: content that exits quoted context to address the agent
  directly (`injection.direct-address`), embedded directives that break out of
  document structure (`injection.system-override` outside quote boundaries)
- Flags content claiming to be system messages or model instructions

**Frequency weights:**

- `injection.role-switch-only`: 2 (reduced from default 10 — common in
  quoted content)

**Audit verbosity floor:** `standard`

### `admin`

For agents with elevated permissions managing configuration, users, or
infrastructure. Highest restriction level.

**Syntactic emphasis (Stage 1A):**

- `addRules`: none (all syntactic rules already active at default)
- `suppressRules`: none (no suppression at admin level)

**Schema strictness (Stage 1B):**

- Strictest — extra fields always block, types always enforced,
  discriminated unions required, tools without declared schema are rejected
  (not accepted with lenient fallback)

> **Difference from general:** `general` allows tools without declared schemas
> to pass with lenient fallback validation. `admin` rejects them outright. An
> admin agent should only call tools with fully declared output contracts.

**Semantic emphasis (Stage 2):**

- All `general` emphasis, plus:
- Flags any content requesting permission escalation
  (`scope-creep.permission-escalation` at block severity, not flag)
- Flags results referencing other agents' memory or session data
  (`scope-creep.cross-agent-reference` at block severity)
- Flags unusual combinations of tool calls (read + write in same result)
- Requires explicit tool scope declaration in MCP results

**Frequency weights:**

- `scope-creep.*`: 15 (elevated from default — scope creep on admin agents is
  high severity)
- `injection.*`: 15 (elevated from default 10)

**Frequency thresholds:**

- tier1: 10 (lowered from default 15 — faster escalation)
- tier2: 20 (lowered from default 30)
- tier3: 35 (lowered from default 50)

**Audit verbosity floor:** `maximum`

---

## Schema Strictness Levels

Schema strictness modulates Stage 1B (schema validation) behavior. It does
NOT disable schema validation — it adjusts tolerance.

### `strict` (default)

Standard schema validation as defined in the input validation spec:

- Transcript: strict allowlist, extra fields fail
- MCP: discriminated unions enforced, extra fields fail, types enforced
- Tools without declared schema: accept JSON object/array, reject bare
  primitives, enforce size limit

### `lenient`

Relaxed field tolerance, type checking retained:

- Transcript: extra top-level fields produce a flag (`syntactic_flags` event),
  not a fail. Missing required fields still fail.
- MCP: extra fields beyond variant declaration produce a flag, not a fail.
  Discriminated union discriminant matching is always strict (lenient does NOT
  relax discriminant validation). Type mismatches still fail.
- Tools without declared schema: same as strict (no further relaxation)

**What lenient does NOT do:**

- Does not relax discriminated union validation
- Does not relax type checking
- Does not relax required field validation
- Does not relax payload size or JSON depth limits (these are structural
  safety checks, not content checks)
- Does not affect Stage 1A (syntactic) at all — syntactic emphasis is a
  separate config axis

### Per-source strictness

Profiles can specify strictness per source type:

```typescript
schemaStrictness: "strict" |
  "lenient" |
  {
    transcript: "strict" | "lenient",
    mcp: "strict" | "lenient",
  };
```

When a flat string is provided, it applies to both sources. When an object
is provided, each source gets its own strictness. This allows profiles like
`customer-service` to be strict on MCP results while being lenient on
transcript content.

---

## Frequency Weight Overrides

Profiles can override individual frequency tracking weights from the input
validation spec. Overrides are merged with global defaults at config load
time — profile values replace matching keys, unmatched keys retain global
defaults.

```typescript
frequencyWeightOverrides?: Record<string, number>
```

Profiles can also override escalation thresholds:

```typescript
frequencyThresholdOverrides?: {
  tier1?: number,
  tier2?: number,
  tier3?: number
}
```

**Merge precedence:** Profile overrides are applied on top of global config
defaults. If the global config explicitly sets a weight, the profile
override replaces it. This means the effective weight for a session is:

```
effectiveWeight = profileOverride ?? globalConfigValue ?? defaultValue
```

**Validation at startup:**

- Weight override keys must be valid rule IDs or valid glob patterns that
  match at least one entry in `RULE_TAXONOMY`
- Weight values must be non-negative numbers
- Threshold overrides must satisfy `tier1 < tier2 < tier3`

---

## Custom Profiles

Operators can define profiles beyond the built-in set. A custom profile is
a JSON file declared in config, loaded at startup, and treated as static for
the agent's lifetime. YAML format is not currently supported.

Custom profile schema:

```typescript
{
  id: string,                        // unique identifier, must not collide
                                     // with built-in profile names
  description: string,               // human-readable description
  baseProfile: BuiltInProfileId,     // inherits from a built-in profile
  overrides: {
    syntacticEmphasis?: {
      addRules?: string[],           // additional ruleIds to emphasize
                                     // must exist in RULE_TAXONOMY
      suppressRules?: string[],      // ruleIds to treat as flags-only
                                     // does NOT override hardBlockRules
    },
    schemaStrictness?: "strict" | "lenient" | {
      transcript: "strict" | "lenient",
      mcp: "strict" | "lenient"
    },
    auditVerbosity?: "minimal" | "standard" | "high" | "maximum",
    frequencyWeightOverrides?: Record<string, number>,
    frequencyThresholdOverrides?: {
      tier1?: number,
      tier2?: number,
      tier3?: number
    },
    subAgentPromptAppend?: string,   // static text appended to selected
                                     // prompt variant
                                     // MUST be static — no template variables
                                     // maximum 4096 bytes
  }
}
```

**Validation at startup:**

- `id` must not collide with built-in profile names
- `baseProfile` must be a valid built-in profile name
- `addRules` entries must exist in `RULE_TAXONOMY`
- `suppressRules` entries must exist in `RULE_TAXONOMY`
- `subAgentPromptAppend` must not exceed 4096 bytes
- `subAgentPromptAppend` must not contain template variables (`${...}`,
  `{{...}}`, `%s`, etc.) — reject at load time with descriptive error
- `frequencyWeightOverrides` keys must match `RULE_TAXONOMY` entries or
  valid glob patterns
- `frequencyThresholdOverrides` must satisfy `tier1 < tier2 < tier3`
  (when partially specified, unspecified values use the base profile's values
  for the comparison)
- File path must be local (no `http://`, `https://`, `ftp://`, or other
  remote URL schemes)
- File path must not contain path traversal (`..`)

**Security constraint:** `subAgentPromptAppend` is loaded from a local file
path declared in config at startup. It is not assembled from user input, session
content, or remote config. The file path itself is validated at load time.

---

## Sub-Agent Prompt Variants

Each built-in profile maps to a static, version-controlled system prompt variant.
Variants are selected at config load time and the assembled prompt is treated as
static for the session lifetime.

> **Implementation note:** Prompt variants are currently defined as inline
> TypeScript string constants in `src/memory/session-sanitization/context-profile.ts`,
> not as separate `.txt` files. The intent is the same — one static string per
> profile, assembled once at config load — but the file-per-variant layout
> described below is the target structure and not yet extracted from code.

Target file structure:

```
src/memory/session-sanitization/prompts/
  base.txt                  ← shared preamble (all variants include this)
  general.txt               ← general profile additions
  customer-service.txt      ← customer-service profile additions
  code-generation.txt       ← code-generation profile additions
  research.txt              ← research profile additions
  admin.txt                 ← admin profile additions
```

At runtime, the sub-agent receives: base preamble + selected profile variant.
Custom profiles receive: base preamble + `baseProfile` variant + `subAgentPromptAppend`.

**Never** assemble the prompt from session content, user messages, or runtime
variables. The profile selection itself (the config field value) is the only
dynamic input to prompt assembly, and it is validated against the known profile
list before use.

---

## Config Surface

```
memory.sessions.sanitization.context.profile: string
  Default: "general"
  Selects the active context profile.
  Built-in values: "general" | "customer-service" | "code-generation" |
                   "research" | "admin"
  Custom values: must match an id in a declared custom profile file.

memory.sessions.sanitization.context.customProfilePath?: string
  Default: undefined
  Path to a custom profile definition file (JSON).
  YAML format is not currently supported.
  Loaded at startup. Not reloaded at runtime without restart.
  Must be a local file path. Remote URLs not accepted.
  Path traversal ("..") not accepted.
```

---

## Audit Integration

### `context_profile_loaded` (minimal tier — always emitted when audit enabled)

Recorded at session start alongside `audit_config_loaded`:

```typescript
{
  event: "context_profile_loaded",
  sessionId: string,
  agentId: string,
  timestamp: string,
  contextProfile: string,   // profile id
  isCustom: boolean,
  baseProfile?: string,     // only present for custom profiles
  schemaStrictness: "strict" | "lenient" | { transcript: string, mcp: string },
  auditVerbosityFloor: string,
  frequencyOverridesApplied: boolean,
  syntacticSuppressedRules: string[],
  syntacticAddedRules: string[]
}
```

This event captures the full resolved profile state at session start, so
audit consumers can reconstruct the exact validation behavior that was
active for any given session without access to the config file.

### Per-turn audit entries

All per-turn audit events include the active profile id:

```typescript
event: "sanitized_pass" | "sanitized_block" | "flags_summary" |
       "rule_triggered" | "output_diff" | ...
  profile: string           // active profile id at time of turn
  ...existing fields
```

This is already implemented in the audit trail spec v2.1 — the `profile`
field appears in `flags_summary`, `rule_triggered`, and `output_diff` event
shapes. This spec confirms that it must also appear in `sanitized_pass` and
`sanitized_block`.

### Profile impact on audit verbosity

The profile's `auditVerbosity` (or `auditVerbosityFloor` for custom profiles)
acts as a **floor**, not an override. The effective verbosity is:

```
effectiveVerbosity = max(globalVerbosity, profileVerbosityFloor)
```

Where the ordering is: minimal < standard < high < maximum.

A profile can raise verbosity for compliance-sensitive contexts (e.g.,
`customer-service` → `high`, `admin` → `maximum`) but cannot lower it below
the operator's global setting. This prevents a profile from silently reducing
audit coverage.

---

## Interaction with Existing Specs

### Input Validation Layers v2.1

| Profile feature                   | Affects           | How                                                                                                  |
| --------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `syntacticEmphasis.addRules`      | Stage 1A          | Additional rules checked with emphasis (higher priority in flag output)                              |
| `syntacticEmphasis.suppressRules` | Stage 1A          | Rules produce flags instead of fails. Does NOT override `twoPass.hardBlockRules`.                    |
| `schemaStrictness`                | Stage 1B          | `lenient` converts extra-field fails to flags. Does not relax type checking or discriminated unions. |
| `frequencyWeightOverrides`        | Frequency scoring | Overrides individual rule weights in decay scoring                                                   |
| `frequencyThresholdOverrides`     | Frequency scoring | Overrides tier escalation thresholds                                                                 |
| Sub-agent prompt variant          | Stage 2           | Different system prompt for semantic analysis                                                        |

### Audit Trail Enhancement v2.1

| Profile feature                          | Affects          | How                                                      |
| ---------------------------------------- | ---------------- | -------------------------------------------------------- |
| `auditVerbosity` / `auditVerbosityFloor` | Verbosity gating | Floor on effective verbosity. Cannot lower below global. |
| `context_profile_loaded` event           | Session start    | Emitted at `minimal` tier.                               |
| `profile` field on per-turn events       | All events       | Already in audit trail spec event shapes.                |

### Audit Alerting v2.1

| Profile feature              | Affects                | How                                                                                                                   |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Profile ID in alert payloads | `AlertPayload.details` | Alerting layer can include active profile in `recentContext` events. No profile-specific alert rules in this version. |

---

## Profile Promotion Path

The intended operator journey:

1. Start with `general` (default, no config change needed)
2. Identify false positives or missing detections in audit log
3. Switch to a more specific built-in profile that matches deployment context
4. If built-in profiles don't fit, define a custom profile based on the closest
   built-in, adding only the overrides needed
5. Version-control the custom profile file alongside agent config

This is intentionally conservative — operators move toward specificity only
after observing behavior, not upfront. The default is always the most restrictive.

---

## Tests

**Profile selection:**

- Default profile is `general` when no config provided
- Each built-in profile name resolves to correct prompt variant
- Unknown profile name fails closed (error at startup, not silent fallback)
- Custom profile loads from declared path and validates against schema
- Custom profile with invalid `baseProfile` fails at startup
- Custom profile with `id` colliding with built-in name fails at startup
- Custom profile with `addRules` referencing unknown rule ID fails at startup
- Custom profile with `subAgentPromptAppend` exceeding 4096 bytes fails at startup
- Custom profile with template variables in `subAgentPromptAppend` fails at startup
- Custom profile path with `..` traversal rejected at startup
- Custom profile path with `http://` scheme rejected at startup

**Prompt assembly:**

- `general` profile produces base + general prompt, nothing else
- Custom profile produces base + baseProfile variant + subAgentPromptAppend
- Assembled prompt contains no template variables or runtime-injected content
- Prompt assembly happens once at config load, not per-turn (verify via mock
  that file read happens once)

**Schema strictness:**

- `strict` profile: extra transcript field → fail
- `lenient` profile: extra transcript field → flag (not fail)
- `lenient` profile: missing required field → still fail
- `lenient` profile: MCP type mismatch → still fail
- `lenient` profile: MCP discriminated union unknown discriminant → still fail
- Per-source strictness: `{ transcript: "lenient", mcp: "strict" }` applies
  correctly to each source
- `admin` profile: tool without declared schema → rejected (not lenient fallback)

**Syntactic emphasis:**

- `code-generation` profile: `structural.encoding-trick` produces flag, not fail
- `suppressRules` item in `twoPass.hardBlockRules` → hard block wins (not suppressed)
- `addRules` entries appear in syntactic filter output with correct ruleIds

**Frequency overrides:**

- Profile weight override replaces global default for matching rule
- Unmatched rules retain global defaults
- Profile threshold overrides respected (e.g., admin tier1 at 10 vs default 15)
- Invalid threshold ordering (`tier1 > tier2`) rejected at startup

**Per-profile behavior (integration):**

- `customer-service`: credential-shaped content in MCP result triggers elevated
  frequency score. Extra fields on transcript content produce flag, not block.
- `code-generation`: base64 in code context produces flag, not block.
  Shell injection in code comment triggers semantic flag.
- `research`: quoted instruction-like phrase does not trigger block;
  direct address to agent does
- `admin`: unexpected field in MCP result always blocks regardless of content.
  Tool without declared schema rejected. Frequency escalation thresholds lower.

**Audit:**

- `context_profile_loaded` event present at session start with full resolved state
- `context_profile_loaded` at `minimal` verbosity — always present
- Per-turn events include active profile id
- Profile id in audit matches config value
- Audit verbosity floor: `customer-service` with global `standard` → effective `high`
- Audit verbosity floor: `admin` with global `standard` → effective `maximum`
- Audit verbosity floor: `general` with global `high` → effective `high` (floor
  doesn't lower)

**Security:**

- Profile selection from user message content is impossible
  (profile is config-only, not a tool parameter)
- `subAgentPromptAppend` from remote URL is rejected at load time
- Profile name containing path traversal characters is rejected
- Custom profile with `suppressRules` covering all injection rules: semantic
  pass still catches injection (suppression only affects Stage 1A, not Stage 2)

---

## Residual Risks (Accepted)

| Risk                                                               | Status                                                                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator selects wrong profile for deployment context              | Accepted. Operator-owned. Audit log surfaces mismatches over time via false positive patterns.                                                                         |
| Custom profile `subAgentPromptAppend` introduces injection surface | Mitigated by static file requirement, local path only, loaded at startup, 4KB limit, no template variables. Residual risk accepted.                                    |
| `suppressRules` reduces syntactic filter sensitivity               | Mitigated by semantic pass remaining fully active. Suppression only affects Stage 1A flag/fail distinction, not detection coverage. `hardBlockRules` takes precedence. |
| Built-in profiles miss novel attack patterns specific to a context | Accepted. Semantic pass is always active. Profiles tune emphasis, not coverage.                                                                                        |
| Profile change requires restart                                    | Accepted. Intentional — dynamic profile changes during a session would create inconsistent audit records and validation behavior.                                      |
| Lenient schema mode may allow extra fields carrying payloads       | Mitigated by semantic pass inspecting all content regardless of schema result. Lenient mode converts fail to flag, not to pass-through.                                |
| Profile frequency weight overrides can reduce sensitivity          | Mitigated by requiring non-negative weights (zero is minimum, not negative). Threshold overrides validated for correct ordering. Operator-owned decision.              |

---

## Out of Scope

- Runtime profile switching without restart
- Per-session profile override by users or agents
- Profile selection based on inbound message classification
- ML-based automatic profile recommendation
- Profile marketplace or community-contributed profiles
- Profile-specific alert rules (future version — alerting spec would need profile-aware rules)
- Per-turn profile switching within a session
