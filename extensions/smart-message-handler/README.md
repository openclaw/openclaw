# Smart Message Handler

Lightweight pre-generation message classifier for OpenClaw. Classifies user messages into 8 execution kinds with sub-millisecond latency, enabling automatic model routing and structured intent signals for downstream consumers.

## Features

- **8-kind intent classification**: `search`, `install`, `read`, `run`, `write`, `debug`, `analyze`, `chat`
- **Weighted keyword scoring**: position multipliers (front 30% = 1.5x, back 30% = 0.8x), context bonuses, substring deduplication
- **Model routing**: 3-tier (`fast` / `standard` / `premium`) routing via `before_model_resolve` hook
- **Embedding cache**: optional n-gram semantic matching for improved accuracy on edge-case inputs
- **Custom phrases**: user-defined intent mappings via `openclaw.json` config or `/smartadd` command
- **Shadow mode**: A/B comparison between the current weighted classifier and a legacy baseline
- **Feedback loop**: ring-buffer tracking of predicted vs. actual tool usage for calibration signal
- **i18n**: execution signal templates in `zh-CN` and `en`
- **Metrics**: in-memory counters + JSONL persistence with 7-day rolling aggregation

## Installation

Add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    allow: ["smart-message-handler"],
    entries: {
      "smart-message-handler": {
        enabled: true,
        config: {
          enabled: true,
          executionSignalEnabled: true,
          modelRoutingEnabled: false,
          locale: "en",
        },
      },
    },
  },
}
```

## Configuration

| Field                        | Type               | Default                                                     | Description                                                                       |
| ---------------------------- | ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `enabled`                    | `boolean`          | `true`                                                      | Enable or disable the plugin entirely                                             |
| `executionSignalEnabled`     | `boolean`          | `true`                                                      | Inject `<execution_signal>` into the prompt for finalized task requests           |
| `scoreThreshold`             | `number`           | `5.0`                                                       | Minimum weighted score a kind must reach to win classification                    |
| `modelRoutingEnabled`        | `boolean`          | `false`                                                     | Enable model tier routing via `before_model_resolve`                              |
| `fastModel`                  | `string`           | `""`                                                        | Model identifier for `fast`-tier requests (`chat`, `unknown`)                     |
| `premiumModel`               | `string`           | `""`                                                        | Model identifier for `premium`-tier requests (`install`, `run`, `write`, `debug`) |
| `locale`                     | `"zh-CN" \| "en"`  | `"zh-CN"`                                                   | Language for injected execution signal instructions                               |
| `shadowModeEnabled`          | `boolean`          | `false`                                                     | Run baseline classifier in parallel and log divergences                           |
| `embeddingCacheEnabled`      | `boolean`          | `false`                                                     | Enable n-gram semantic matching via embedding cache                               |
| `embeddingCachePath`         | `string`           | `""`                                                        | Path to embedding cache JSON produced by `tools/generate-embeddings.ts`           |
| `customPhrases`              | `{phrase, kind}[]` | `[]`                                                        | Static user-defined phrase → kind mappings, matched before keyword scoring        |
| `disableForLocalMainSession` | `boolean`          | `true`                                                      | Skip prompt rewriting for the `agent:main:main` local CLI test session            |
| `incompleteSignals`          | `string[]`         | `["...", "，", ",", "、", "待续", "continue"]`              | Tokens that indicate the message is not yet complete                              |
| `completeSignals`            | `string[]`         | `["。", "？", "?", "！", "!", " done", " 完了", " 就这些"]` | Tokens that confirm the message is complete                                       |
| `baseDebounceMultiplier`     | `number`           | `1.5`                                                       | Debounce multiplier applied when input appears incomplete                         |
| `maxDebounceMultiplier`      | `number`           | `3`                                                         | Cap on the debounce multiplier                                                    |
| `minMessageLength`           | `number`           | `3`                                                         | Minimum message length before completion signals are evaluated                    |
| `debug`                      | `boolean`          | `false`                                                     | Emit verbose log lines to the gateway log                                         |

## Commands

| Command                     | Description                                                                      |
| --------------------------- | -------------------------------------------------------------------------------- |
| `/smartstatus`              | Show active session count, embedding cache state, and resolved config            |
| `/smartreset`               | Clear all in-memory session state                                                |
| `/smartmetrics`             | Show today's in-memory classification metrics                                    |
| `/smartmetrics weekly`      | Show aggregated metrics from the last 7 days of JSONL persistence                |
| `/smartadd <kind> <phrase>` | Add a runtime custom phrase mapping (non-persistent; use config for persistence) |
| `/smartfeedback`            | Show predicted vs. actual tool usage report from the feedback ring buffer        |
| `/smartshadow`              | Show shadow mode divergence report (requires `shadowModeEnabled: true`)          |

## Architecture

```
User message
     │
     ▼
before_prompt_build hook
     │
     ├─ 1. Session check (disableForLocalMainSession guard)
     │
     ├─ 2. recordMessage → debounce multiplier calculation
     │
     ├─ 3. classifyMessage
     │        ├─ custom phrase match  (highest priority)
     │        ├─ embedding cache match (if enabled, sim ≥ 0.6)
     │        └─ weighted keyword scoring
     │              ├─ stripCodeAndQuotes
     │              ├─ scoreMessage (position multiplier + context bonus)
     │              └─ tie-break by TIE_BREAK_PRIORITY
     │
     ├─ 4. buildDynamicExecutionSignal → prependContext XML
     │
     ├─ 5. recordClassification (metrics + JSONL flush)
     │
     └─ 6. shadow mode comparison (if enabled)

before_model_resolve hook
     └─ suggested_tier → modelOverride (if modelRoutingEnabled)

after_tool_call hook
     └─ recordToolUsage (feedback ring buffer)
```

## Model Routing

Classification results map to three tiers. Enable with `modelRoutingEnabled: true` and set `fastModel` / `premiumModel`.

| Tier       | Kinds                              | Behavior                               |
| ---------- | ---------------------------------- | -------------------------------------- |
| `fast`     | `chat`, `unknown`                  | Routes to `fastModel` if configured    |
| `standard` | `search`, `read`, `analyze`        | Uses the session default model         |
| `premium`  | `install`, `run`, `write`, `debug` | Routes to `premiumModel` if configured |

Example config for tier routing:

```json5
{
  modelRoutingEnabled: true,
  fastModel: "claude-haiku-4-5",
  premiumModel: "claude-opus-4-5",
}
```

## Integration with multi-agent-orchestrator

When `executionSignalEnabled` is `true`, the plugin prepends a `<pre_computed_verdict>` block to the prompt on every finalized non-chat request. MAO can read this block directly and skip its own `inferExecutionComplexity` pass.

```xml
<pre_computed_verdict>
  <input_finalized>true</input_finalized>
  <execution_expected>true</execution_expected>
  <execution_kind>debug</execution_kind>
  <policy_required>true</policy_required>
  <delegation_preferred>false</delegation_preferred>
  <classifier_version>2.0-weighted</classifier_version>
  <verdict_authority>smart-message-handler</verdict_authority>
</pre_computed_verdict>
```

**MAO integration contract**:

1. At `inferExecutionComplexity` entry, detect `<pre_computed_verdict>` in the prompt.
2. If present and `verdict_authority === "smart-message-handler"`, adopt `policy_required`, `delegation_preferred`, and `execution_kind` directly — skip re-classification.
3. If absent (non-SMH channel), fall back to MAO's own classification logic.

The plugin also exports `buildPreComputedVerdict(intent: ExecutionIntent): PreComputedVerdict` for programmatic integration.

## File Structure

```
~/.openclaw/extensions/smart-message-handler/
├── openclaw.plugin.json       # Plugin manifest + config schema
├── index.ts                   # Entry point — register() glue code
├── package.json               # Package config
├── tsconfig.json              # TypeScript type-checking config
├── smoke-test.ts              # Integration smoke tests
├── README.md                  # This document
├── src/
│   ├── types.ts               # Types, interfaces, constants, scoring rules
│   ├── config.ts              # Config reader + runtime type validation
│   ├── classifier.ts          # Weighted scoring engine + classifyMessage
│   ├── custom-phrases.ts      # Custom phrase substring matching
│   ├── session-state.ts       # Immutable session state + LRU store
│   ├── signal-builder.ts      # Execution signal + pre_computed_verdict builder
│   ├── debounce.ts            # Debounce multiplier calculation + debug logging
│   ├── metrics.ts             # In-memory counters + JSONL persistence + weekly aggregation
│   ├── feedback.ts            # Prediction vs. actual tool usage ring buffer
│   ├── embedding-cache.ts     # Embedding cache loader + cosine/n-gram text matching
│   ├── locale.ts              # zh-CN / en signal instruction strings
│   └── shadow.ts              # Shadow mode: baseline classifier + divergence report
├── tools/
│   ├── calibrate.ts           # Offline weight/threshold calibration tool
│   ├── benchmark.ts           # Classification latency benchmark
│   └── generate-embeddings.ts # Embedding cache JSON generator
└── tests/
    ├── classifier.test.ts
    ├── session-state.test.ts
    ├── debounce.test.ts
    ├── signal-builder.test.ts
    ├── config.test.ts
    ├── custom-phrases.test.ts
    ├── feedback.test.ts
    ├── embedding-cache.test.ts
    ├── locale.test.ts
    ├── shadow.test.ts
    └── metrics.test.ts
```

## Tools

- `npm run calibrate` — offline accuracy/threshold calibration against a labeled dataset
- `npm run benchmark` — measure classification latency across a message corpus

## Development

```bash
npm test          # run vitest unit tests
npm run smoke     # run smoke tests (requires Node >= 22)
npm run check     # oxlint static analysis
npm run typecheck # tsc --noEmit type check
```

## Version History

- **v1.0.0**: Initial release — dynamic debounce, message completeness detection, session state tracking
- **v1.1.0**: Execution policy gate — injects `enforce_execution_policy` guidance for complex task requests; aligns with `multi-agent-orchestrator` executionPolicy
- **v2.0.0**: Modular rewrite — split into 6 independent `src/` modules; weighted scoring engine replaces first-match classification; layered HIGH/LOW confidence verb policy gate; semantic delegation detection
- **v2.1.0**: Engineering hardening — Symbol-keyed `SessionStore` eliminates type coercions; `getConfig` runtime validation; `scoreMessage` context bonus keyword guard; `DebugLogger` interface; input truncation protection; ReDoS defense
- **v2.2.0**: Shadow mode + calibration + MAO decoupling + JSONL persistence — baseline divergence report (`/smartshadow`); offline `calibrate.ts` tool; `pre_computed_verdict` XML decouples SMH from MAO re-classification; JSONL metrics log with weekly aggregation
- **v2.3.0**: Custom phrases + feedback loop + embedding cache — `/smartadd` runtime phrase mapping; prediction vs. tool usage ring buffer (`/smartfeedback`); n-gram semantic matching via embedding cache
- **v2.4.0**: i18n — `zh-CN` and `en` execution signal templates via `locale` config field
- **v3.0.0**: PR-ready refactor — stripped MAO overlap; introduced `MessageClassification` type with `confidence`, `suggested_tier`, and `score` fields; `before_model_resolve` model routing hook; `ModelTier` 3-tier routing table
