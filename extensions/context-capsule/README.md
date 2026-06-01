# context-capsule — OpenClaw ContextEngine plugin

Compresses agent session history before it reaches the LLM using
[`@parad0x_labs/context-capsule`](https://github.com/Parad0x-Labs/dna-x402/tree/main/packages/context-capsule).
Sessions under 20 messages pass through unchanged. Longer sessions have their
older history compressed into a capsule summary (injected as a system message)
while the last 10 messages are kept verbatim — giving the model full coherence
on recent turns without paying for the full transcript.

**Most useful for:** local models (Ollama, LM Studio) and GPT-4 where context
cost matters. Claude users with a 200k context window and built-in compaction
enabled may not need this.

## Benchmark

| Metric | Result | CI gate |
|---|---|---|
| Token savings | 99.3% | >= 95% |
| Recovery score | 100% | >= 90% |
| Runtime | 29ms | < 1000ms |

Reproduce locally:

```sh
cd packages/context-capsule
npm run bench:public
```

CI fails if savings drop below 95% or recovery falls below 90%.

## Activation

```jsonc
// openclaw.json
{
  "plugins": {
    "slots": {
      "contextEngine": "context-capsule"
    }
  }
}
```

## Config options

| Key | Default | Description |
|---|---|---|
| `minMessages` | `20` | Sessions shorter than this pass through unchanged |
| `keepRecentMessages` | `10` | Recent messages kept verbatim after compression |

```jsonc
{
  "plugins": {
    "entries": {
      "context-capsule": {
        "minMessages": 15,
        "keepRecentMessages": 8
      }
    }
  }
}
```
