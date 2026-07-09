# Harness Integration

## Goal

Make every prompt/response auditable without pretending closed-model hidden thoughts are visible.

The harness should capture enough structured data to answer:

- What did the model see?
- What did it say?
- What tools did it choose?
- What evidence did it use?
- What uncertainty or constraints did it report?
- What changed when the prompt was perturbed?
- If local activations are available, what did J-Lens read?

## Trace Schema

Use this shape for each assistant turn:

```json
{
  "trace_version": "j-lens-observability/v1",
  "run_id": "uuid",
  "turn_id": "uuid-or-index",
  "timestamp": "iso8601",
  "harness": "openclaw|claude|codex|generic",
  "model": "model-id",
  "sampling": {
    "temperature": null,
    "top_p": null,
    "seed": null
  },
  "input": {
    "system_hash": "sha256-or-null",
    "developer_hash": "sha256-or-null",
    "user_hash": "sha256",
    "user_excerpt": "short excerpt"
  },
  "output": {
    "assistant_hash": "sha256",
    "assistant_excerpt": "short excerpt",
    "finish_reason": "stop|tool|length|error|null"
  },
  "tools": [
    {
      "name": "tool-name",
      "arguments_hash": "sha256",
      "result_hash": "sha256",
      "result_excerpt": "short excerpt"
    }
  ],
  "usage": {
    "input_tokens": null,
    "output_tokens": null,
    "cost": null,
    "latency_ms": null
  },
  "rationale_packet": {
    "decision_summary": null,
    "evidence_used": [],
    "assumptions": [],
    "uncertainty": [],
    "alternatives_considered": [],
    "constraints_checked": [],
    "tool_rationale": []
  },
  "observability": {
    "mode": "closed-model|activation-level|mixed",
    "visible_thinking_blocks": false,
    "thinking_blocks_redacted": true,
    "jlens_readout": null,
    "black_box_probe_set": null
  }
}
```

## Rationale Packet Prompt

For closed models, ask for a concise public rationale packet after the answer:

```text
Return an observability packet for the answer above. Do not reveal hidden chain-of-thought. Provide:
1. decision summary
2. evidence used
3. assumptions
4. uncertainties
5. alternatives considered
6. constraints or safety checks
7. tools used or considered
8. what would change the answer
```

Do not call this chain-of-thought. It is an auditable summary.

## OpenClaw

Install the skill at:

- `~/.openclaw/skills/j-lens-observability/`
- or `<workspace>/skills/j-lens-observability/`

OpenClaw already has session JSONL conventions in its `session-logs` skill. Use `scripts/jlens_trace.py` against:

```bash
~/.openclaw/agents/<agentId>/sessions/
```

For first-class integration, add trace emission around:

- provider request construction
- provider streaming deltas
- tool-call creation
- tool-result ingestion
- final assistant message persistence

## Claude

Install the skill at:

- `~/.claude/skills/j-lens-observability/`
- or a project-local skills directory if the harness supports it

Claude Code may expose public summaries or extended thinking depending on configuration and product surface. Treat logged thinking blocks as recorded artifacts, not as something to coerce from the live model.

## Codex

Install the skill at:

- `~/.codex/skills/j-lens-observability/`
- or a project-local skills/plugin location if used by the environment

For Codex, prefer explicit rationale summaries and tool traces. Do not request hidden reasoning. Capture:

- developer/system instruction hashes when available
- tool calls and results
- plan updates
- command outputs
- final answer

## Generic Harness

Add middleware with these hooks:

- `before_model_call(request)`
- `on_stream_delta(delta)`
- `on_tool_call(call)`
- `on_tool_result(result)`
- `after_model_call(response)`
- `after_rationale_packet(packet)`
- `after_probe_run(probe_result)`

Persist JSONL with one object per event and a shared `run_id`.

## Activation-Level Mode

Only use this mode when:

- the model is local/open-weight or otherwise exposes residual-stream activations
- the tokenizer and model architecture are supported
- a fitted J-Lens exists or can be fit
- the run records layer, position, top-k tokens, scores, and lens version

Store readouts like:

```json
{
  "mode": "activation-level",
  "lens": "jacobian-lens",
  "model": "org/model",
  "layer": 42,
  "position": 17,
  "top_tokens": [
    {"token": "fake", "score": 0.91},
    {"token": "injection", "score": 0.88}
  ]
}
```
