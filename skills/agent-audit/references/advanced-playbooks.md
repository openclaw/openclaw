# Advanced Playbooks

Use these when the target system is not merely flaky, but structurally compromised.

## false-confidence

Use when:

- the agent sounds decisive while evidence is weak or missing
- the wrapper adds confidence without adding truth

## stale-evidence-replay

Use when:

- old outputs are repeated as if they were current
- the agent reuses a prior status after the system changed

## fake-agentic-depth

Use when:

- the system looks more agentic but gets less reliable
- extra planning, recap, or orchestration layers degrade truthfulness

## hidden-repair-brain

Use when:

- platform or fallback code silently spins up a second model pass
- good answers become worse during repair or downgrade

## memory-poisoning

Use when:

- assistant self-talk becomes durable knowledge
- same-session facts teach the agent the wrong thing

## protocol-decay

Use when:

- internal state is carried as prose instead of typed data
- markdown becomes the protocol
- intermediate layers keep paraphrasing each other
