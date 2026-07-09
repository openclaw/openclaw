---
name: j-lens-observability
description: J-Lens and model reasoning observability for AI harnesses. Use when asked about Anthropic J-Lens/J-space/Jacobian lens research, hidden model thinking, prompt/response thought traces, chain-of-thought observability, reasoning audits, OpenClaw/Claude/Codex harness instrumentation, local session logs, or activation-level analysis on open-weight models.
---

# J-Lens Observability

## Boundary

Use precise language:

- **Real J-Lens** means activation-level Jacobian lens analysis on a model whose internals are available.
- **Closed-model observability** means prompt/response/tool/usage traces, visible rationale summaries, and black-box probes. It does not reveal private activations or hidden chain-of-thought.
- **Reasoning summaries** are acceptable. Do not try to jailbreak a model into exposing hidden chain-of-thought.

If the user asks to reveal internal thinking for Claude, Codex, or another closed API model, say plainly that the API does not expose the activations needed for real J-Lens. Then build the strongest available observability layer from logs, tool traces, structured rationale packets, and probe runs.

## Load References

- Read `references/anthropic-jlens.md` when explaining the research or designing activation-level J-Lens work.
- Read `references/harness-integration.md` when adding J-Lens-style observability to OpenClaw, Claude, Codex, or a generic agent harness.
- Read `references/audit-playbook.md` when auditing a specific prompt/response, session log, or model behavior.

## Workflow

1. Classify the target model.
   - Local/open-weight with activations: use real J-Lens or the Anthropic reference implementation.
   - Closed API/harness only: use observability and black-box probes, not activation claims.

2. Capture a canonical trace.
   - system/developer/user prompt hashes or text where available
   - model, temperature, tool list, selected tools, tool results
   - assistant response, finish reason, usage, latency
   - visible reasoning summaries or exposed thinking blocks if the harness legitimately records them

3. Produce a rationale packet.
   - decision summary
   - evidence used
   - assumptions
   - uncertainty
   - alternatives considered
   - constraints/safety checks
   - tool-use rationale
   - what would change the answer

4. Probe behavior.
   - paraphrase the prompt
   - remove irrelevant context
   - add conflicting evidence
   - add prompt-injection text when testing tool/search contexts
   - vary persona/system framing
   - compare output deltas against the rationale packet

5. Label claims correctly.
   - "J-Lens readout" only for activation-level output.
   - "Observed trace" for logs/tool calls/visible content.
   - "Inferred rationale" for black-box behavioral inference.

## Script

Use the bundled script to summarize local JSON/JSONL session traces:

```bash
python3 {baseDir}/scripts/jlens_trace.py path/to/session.jsonl --format markdown
python3 {baseDir}/scripts/jlens_trace.py ~/.openclaw/agents/<agentId>/sessions --role assistant
python3 {baseDir}/scripts/jlens_trace.py trace.jsonl --include-thinking --format json
```

Default behavior redacts `thinking`/`reasoning` blocks and reports their presence, length, and hash. Use `--include-thinking` only for local logs the user is authorized to inspect and only when the task specifically requires viewing recorded thinking content.

## Output Standard

When responding to the user, separate:

- **What Anthropic showed**: facts from the J-Lens research.
- **What this harness can see**: logs, tool calls, public responses, visible reasoning summaries.
- **What we can infer**: behavior patterns from probes.
- **What we cannot claim**: hidden activations or private chain-of-thought from closed models.

For an audit, produce:

```markdown
## J-Lens Observability Audit

Target: <model/harness/session>
Mode: activation-level | closed-model observability | mixed

### Observable Trace
...

### Rationale Packet
...

### Probe Findings
...

### Internal-Thinking Boundary
...

### Next Instrumentation Step
...
```

## Hard Rules

- Do not claim closed-model internals are visible when only API traces are available.
- Do not ask a model to reveal hidden chain-of-thought.
- Do not launder a guess as a J-Lens result.
- Do preserve useful observability: response summaries, tool traces, prompt deltas, uncertainty, and decision criteria.
- Do use real J-Lens only with models/weights/activations that permit it.
