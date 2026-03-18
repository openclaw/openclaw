# Smart Message Handler — API Reference

## Exported Functions

### `classifyMessage(message, config) → MessageClassification`

Main entry point. Classifies a message and returns a full `MessageClassification` with kind,
confidence, score, and model tier suggestion.

```typescript
import { classifyMessage } from "smart-message-handler";
import { DEFAULT_CONFIG } from "smart-message-handler/src/types";

const result = classifyMessage("修复这个 TypeError。", DEFAULT_CONFIG);
// => {
//   kind: "debug",
//   confidence: "high",
//   input_finalized: true,
//   execution_expected: true,
//   suggested_tier: "premium",
//   classifier_version: "2.0-weighted",
//   score: 13.5
// }
```

### `classifyExecutionIntent(message, config) → ExecutionIntent`

Lower-level function. Returns intent fields without confidence/score. Used by the calibration
tool and shadow mode baseline.

```typescript
import { classifyExecutionIntent } from "smart-message-handler";

const intent = classifyExecutionIntent("npm install axios。", DEFAULT_CONFIG);
// => { input_finalized: true, execution_expected: true, execution_kind: "install" }
```

### `buildExecutionSignal(intent) → string | null`

Builds the `<message_classification>` XML block from a `MessageClassification` or
`ExecutionIntent`. Returns `null` when input is not finalized or kind is `"chat"`.

```typescript
import { classifyMessage, buildExecutionSignal } from "smart-message-handler";

const classification = classifyMessage("跑一下 pnpm build。", DEFAULT_CONFIG);
const xml = buildExecutionSignal(classification);
// => "<message_classification>...</message_classification>"
// or null for chat/unfinished messages
```

### `buildPreComputedVerdict(intent) → PreComputedVerdict`

Builds a `PreComputedVerdict` struct from an `ExecutionIntent`. Used by MAO to consume the
classifier result without re-parsing XML.

```typescript
import { classifyExecutionIntent, buildPreComputedVerdict } from "smart-message-handler";

const intent = classifyExecutionIntent("搜索 TODO 注释。", DEFAULT_CONFIG);
const verdict = buildPreComputedVerdict(intent);
// => {
//   input_finalized: true,
//   execution_expected: true,
//   execution_kind: "search",
//   classifier_version: "2.0-weighted"
// }
```

---

## Exported Types

### `MessageClassification`

```typescript
interface MessageClassification {
  readonly kind: ExecutionKind;
  readonly confidence: ConfidenceLevel;
  readonly input_finalized: boolean;
  readonly execution_expected: boolean;
  readonly suggested_tier: ModelTier;
  readonly classifier_version: string;
  readonly score: number;
}
```

### `ExecutionIntent`

```typescript
interface ExecutionIntent {
  readonly input_finalized: boolean;
  readonly execution_expected: boolean;
  readonly execution_kind: ExecutionKind;
}
```

### `ExecutionKind`

```typescript
type ExecutionKind =
  | "search" // Search/find in codebase
  | "install" // Package installation
  | "read" // Read/view files
  | "run" // Execute commands
  | "write" // Create/modify code
  | "debug" // Debug/fix issues
  | "analyze" // Analyze/explain code
  | "chat" // Conversational message
  | "unknown"; // Below threshold, cannot determine
```

### `SmartHandlerConfig`

```typescript
interface SmartHandlerConfig {
  readonly enabled: boolean;
  readonly incompleteSignals: string[]; // e.g. ["...", "，", ","]
  readonly completeSignals: string[]; // e.g. ["。", "?", "!"]
  readonly baseDebounceMultiplier: number; // default 1.5
  readonly maxDebounceMultiplier: number; // default 3
  readonly minMessageLength: number; // default 3
  readonly debug: boolean;
  readonly executionSignalEnabled: boolean;
  readonly disableForLocalMainSession: boolean;
  readonly shadowModeEnabled: boolean;
  readonly customPhrases: readonly { readonly phrase: string; readonly kind: ExecutionKind }[];
  readonly embeddingCacheEnabled: boolean;
  readonly embeddingCachePath: string;
  readonly locale: "zh-CN" | "en";
  readonly scoreThreshold: number; // default 5.0
  readonly modelRoutingEnabled: boolean;
  readonly fastModel: string; // e.g. "claude-haiku-4-5"
  readonly premiumModel: string; // e.g. "claude-opus-4-5"
}
```

### `PreComputedVerdict`

```typescript
interface PreComputedVerdict {
  readonly input_finalized: boolean;
  readonly execution_expected: boolean;
  readonly execution_kind: ExecutionKind;
  readonly classifier_version: string;
}
```

### `ConfidenceLevel`

```typescript
type ConfidenceLevel = "high" | "medium" | "low";
// high:   score >= scoreThreshold * 2
// medium: score >= scoreThreshold
// low:    score < scoreThreshold
```

### `ModelTier`

```typescript
type ModelTier = "fast" | "standard" | "premium";
// fast:     chat, unknown
// standard: search, read, analyze
// premium:  install, run, write, debug
```

---

## Commands

Registered via `api.registerCommand`. Invoked with `/` prefix in the OpenClaw CLI.

| Command                     | Arguments        | Description                                                             |
| --------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `/smartstatus`              | —                | Show plugin status: active sessions, embedding cache, current config    |
| `/smartreset`               | —                | Clear all session state                                                 |
| `/smartmetrics`             | —                | Show current-session classification metrics                             |
| `/smartmetrics weekly`      | —                | Aggregate metrics from persisted JSONL log (last 7 days)                |
| `/smartshadow`              | —                | Show shadow mode divergence report (requires `shadowModeEnabled: true`) |
| `/smartadd <kind> <phrase>` | `kind`, `phrase` | Add a runtime custom intent phrase (non-persistent)                     |
| `/smartfeedback`            | —                | Show prediction vs actual tool-usage feedback report                    |

---

## Configuration Reference

Full config table with defaults:

| Key                          | Type              | Default                                                     | Description                                             |
| ---------------------------- | ----------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `enabled`                    | boolean           | `true`                                                      | Enable/disable the plugin                               |
| `incompleteSignals`          | string[]          | `["...", "，", ",", "、", "待续", "continue"]`              | Suffixes that mark an unfinished message                |
| `completeSignals`            | string[]          | `["。", "？", "?", "！", "!", " done", " 完了", " 就这些"]` | Suffixes that mark a complete message                   |
| `baseDebounceMultiplier`     | number            | `1.5`                                                       | Base debounce multiplier                                |
| `maxDebounceMultiplier`      | number            | `3`                                                         | Maximum debounce multiplier                             |
| `minMessageLength`           | number            | `3`                                                         | Minimum length to classify as actionable                |
| `debug`                      | boolean           | `false`                                                     | Enable verbose debug logging                            |
| `executionSignalEnabled`     | boolean           | `true`                                                      | Inject `<message_classification>` XML into prompt       |
| `disableForLocalMainSession` | boolean           | `true`                                                      | Skip injection for `agent:main:main` session            |
| `shadowModeEnabled`          | boolean           | `false`                                                     | Run baseline classifier in parallel and log divergences |
| `customPhrases`              | array             | `[]`                                                        | Phrase→kind overrides matched before keyword scoring    |
| `embeddingCacheEnabled`      | boolean           | `false`                                                     | Enable embedding-based semantic matching                |
| `embeddingCachePath`         | string            | `""`                                                        | Path to embedding cache JSON file                       |
| `locale`                     | `"zh-CN" \| "en"` | `"zh-CN"`                                                   | Language for classification signals                     |
| `scoreThreshold`             | number            | `5.0`                                                       | Minimum weighted score to accept a classification       |
| `modelRoutingEnabled`        | boolean           | `false`                                                     | Enable model routing via `before_model_resolve` hook    |
| `fastModel`                  | string            | `""`                                                        | Model ID for fast-tier (chat, unknown)                  |
| `premiumModel`               | string            | `""`                                                        | Model ID for premium-tier (install, run, write, debug)  |

---

## Tools

### `tools/calibrate.ts`

Offline threshold calibration tool. Evaluates classifier accuracy on a labeled corpus and
performs a grid search over `scoreThreshold` values.

```bash
node --experimental-strip-types tools/calibrate.ts              # built-in corpus
node --experimental-strip-types tools/calibrate.ts my-data.jsonl  # custom JSONL
```

### `tools/benchmark.ts`

Performance latency benchmark. Runs the full `classifyMessage` pipeline across 64 representative
messages for 1000 iterations and reports P50/P95/P99/max latencies.

```bash
node --experimental-strip-types tools/benchmark.ts
# or
npm run benchmark
```

Sample output (M-series Mac, Node 22):

```
Messages: 64
Iterations: 1000
Total classifications: 64000

--- Latency Results ---
Average: 0.012ms
P50:     0.011ms
P95:     0.018ms
P99:     0.037ms
Max:     1.669ms

All within <500ms constraint: YES
All within <1ms:              NO
```
