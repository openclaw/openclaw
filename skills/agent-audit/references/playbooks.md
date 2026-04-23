# Playbooks

Use one of these as the primary audit mode.

## wrapper-regression

Use when:

- the base model seems strong, but the wrapped agent behaves much worse
- users say the model is fine elsewhere, but the wrapped system becomes unreliable

Focus:

- wrapper layering
- duplicated context injection
- hidden formatting or fallback layers
- answer degradation after orchestration

## memory-contamination

Use when:

- the agent drags old topics into new questions
- the same session seems to teach itself bad facts
- long-term memory and session history blur together

Focus:

- same-session artifact reentry
- stale session reuse
- weak memory admission criteria
- aggressive distillation cadence

## tool-discipline

Use when:

- the agent should have used a tool but did not
- the wrong tool was selected
- tool evidence was available but the conclusion drifted anyway

Focus:

- code-enforced vs prompt-enforced tool requirements
- preflight probes
- tool-call skip paths
- stale evidence reuse

## rendering-transport

Use when:

- the answer seems correct internally but broken in delivery
- raw markdown leaks into cards or channel payloads
- rendering or transport changes semantics

Focus:

- transport payload shape assumptions
- deterministic fallback behavior
- platform-layer mutations

## hidden-agent-layers

Use when:

- there are repair, retry, summarize, or recap loops hidden in the stack
- unexpected second-pass model calls mutate outputs

Focus:

- hidden repair agents
- recap or recall loops
- maintenance-worker synthesis paths
- transport repair prompts
