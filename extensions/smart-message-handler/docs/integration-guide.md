# Smart Message Handler — Integration Guide

## For Multi-Agent-Orchestrator (MAO)

The classifier injects a `<message_classification>` XML block into the prompt context via the
`before_prompt_build` hook. MAO can parse this block to skip its own `inferExecutionComplexity`
when the classifier has already provided a verdict.

### XML Format

```xml
<message_classification>
<kind>debug</kind>
<confidence>high</confidence>
<input_finalized>true</input_finalized>
<execution_expected>true</execution_expected>
<suggested_tier>premium</suggested_tier>
<score>13.5</score>
<classifier_version>2.0-weighted</classifier_version>
</message_classification>
```

Fields:

| Field                | Values                                                                             | Description                                     |
| -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `kind`               | `search \| install \| read \| run \| write \| debug \| analyze \| chat \| unknown` | Classified intent                               |
| `confidence`         | `high \| medium \| low`                                                            | Confidence level based on score vs threshold    |
| `input_finalized`    | `true \| false`                                                                    | Whether the message ends with a complete signal |
| `execution_expected` | `true \| false`                                                                    | `input_finalized && length >= minMessageLength` |
| `suggested_tier`     | `fast \| standard \| premium`                                                      | Recommended model tier                          |
| `score`              | number                                                                             | Raw weighted score from keyword engine          |
| `classifier_version` | string                                                                             | `"2.0-weighted"`                                |

### Consuming in MAO

At the top of `inferExecutionComplexity`, check for the block before running your own scoring:

```typescript
// Pseudocode for MAO integration
function inferExecutionComplexity(promptContext: string) {
  const classification = parseMessageClassification(promptContext);

  if (classification && classification.execution_expected) {
    // Trust SMH verdict — skip local re-classification
    return {
      policyRequired: classification.suggested_tier === "premium",
      delegationPreferred: false,
      executionKind: classification.kind,
    };
  }

  // Fallback: run MAO's own classification logic
  return runLocalComplexityInference(promptContext);
}

function parseMessageClassification(ctx: string) {
  const match = ctx.match(/<message_classification>([\s\S]*?)<\/message_classification>/);
  if (!match) return null;
  return {
    kind: extractTag(match[1], "kind"),
    confidence: extractTag(match[1], "confidence"),
    execution_expected: extractTag(match[1], "execution_expected") === "true",
    suggested_tier: extractTag(match[1], "suggested_tier"),
  };
}
```

This eliminates the double-classification conflict that can occur when both SMH and MAO score the
same message independently.

The plugin also exports `buildPreComputedVerdict(intent)` for programmatic integration:

```typescript
import { buildPreComputedVerdict, classifyExecutionIntent } from "smart-message-handler";
import { DEFAULT_CONFIG } from "smart-message-handler/src/types";

const intent = classifyExecutionIntent("修复这个 TypeError。", DEFAULT_CONFIG);
const verdict = buildPreComputedVerdict(intent);
// => { input_finalized, execution_expected, execution_kind, classifier_version }
```

---

## For Model Routing

Enable model routing to automatically select the optimal model based on task complexity.
The `before_model_resolve` hook fires after classification and returns a `modelOverride` when
the tier matches a configured model.

### Configuration

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    allow: ["smart-message-handler"],
    entries: {
      "smart-message-handler": {
        enabled: true,
        config: {
          modelRoutingEnabled: true,
          fastModel: "claude-haiku-4-5",
          premiumModel: "claude-opus-4-5",
          scoreThreshold: 5.0,
        },
      },
    },
  },
}
```

`standard` tier (search, read, analyze) uses whatever model the session already has configured —
no override is applied for that tier.

### Tier Mapping

| Kind      | Tier     | Rationale                              |
| --------- | -------- | -------------------------------------- |
| `chat`    | fast     | Lightweight, no code reasoning needed  |
| `unknown` | fast     | Insufficient signal — default to cheap |
| `search`  | standard | Index scan, moderate context           |
| `read`    | standard | File retrieval, moderate context       |
| `analyze` | standard | Explanation, moderate reasoning        |
| `install` | premium  | Package resolution, side effects       |
| `run`     | premium  | Command execution, side effects        |
| `write`   | premium  | Code generation, multi-file changes    |
| `debug`   | premium  | Root cause analysis, complex reasoning |

---

## For Custom Classifiers

Add custom intent phrases that are matched before keyword scoring. Custom phrases are exact
substring matches and take priority over the weighted scoring engine.

### Via openclaw.json (persistent)

```json5
{
  plugins: {
    entries: {
      "smart-message-handler": {
        config: {
          customPhrases: [
            { phrase: "跑 CI", kind: "run" },
            { phrase: "上线", kind: "run" },
            { phrase: "代码审查", kind: "analyze" },
          ],
        },
      },
    },
  },
}
```

### Via /smartadd command (runtime, non-persistent)

```
/smartadd run 跑 CI
/smartadd debug 这里又挂了
/smartadd analyze 代码审查
```

Runtime additions are cleared on plugin stop. To make them permanent, add them to `customPhrases`
in `openclaw.json`.

---

## For Calibration

Use the built-in calibration tool to find the optimal `scoreThreshold` for your message corpus.

```bash
# Run with built-in test corpus (28 labeled samples)
node --experimental-strip-types tools/calibrate.ts

# Run with your own labeled data (JSONL format)
node --experimental-strip-types tools/calibrate.ts my-corpus.jsonl
```

JSONL format (one sample per line):

```json
{"message": "帮我找一下 bug", "expected_kind": "debug"}
{"message": "你好", "expected_kind": "chat"}
{"message": "npm install axios。", "expected_kind": "install"}
```

The tool performs a grid search over `scoreThreshold` values `[3.0, 4.0, 5.0, 6.0, 7.0, 8.0]`
and reports accuracy at each threshold. Apply the recommended threshold to `openclaw.json`:

```json5
{
  config: {
    scoreThreshold: 5.0, // recommended value from calibrate output
  },
}
```

---

## Performance Reference

Benchmark results (`node --experimental-strip-types tools/benchmark.ts`, 64 messages × 1000 iterations):

```json
{
  "messages": 64,
  "iterations": 1000,
  "total": 64000,
  "avg": 0.012,
  "p50": 0.011,
  "p95": 0.018,
  "p99": 0.037,
  "max": 1.669
}
```

All latencies in milliseconds. P99 < 0.04ms — well within the <500ms constraint.
