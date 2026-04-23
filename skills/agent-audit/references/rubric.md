# Audit Rubric

Use this rubric when producing `agent_check_report.json`.

## 1. Context cleanliness

Check:

- Is the same information injected through multiple layers?
- Are model-generated summaries fed back as context?
- Is session history carrying stale facts forward?
- Are current-session artifacts re-entering the same turn?

## 2. Tool discipline

Check:

- Are tools merely available, or actually required in code?
- Can the model skip tools and still answer?
- Does the runtime bind final answers to current-turn evidence?

## 3. Failure handling

Check:

- Does a send or render failure trigger another hidden agent?
- Is there a deterministic fallback path?
- Are failures visible and attributable?

## 4. Memory admission

Check:

- Can assistant self-talk become long-term memory?
- Are user corrections weighted more than assistant assertions?
- Is there a stable-window or evidence gate before distillation?

## 5. Answer shaping

Check:

- Is the final response derived from structured evidence?
- Does formatting add noise or rewrap already-correct answers?
- Does platform rendering leak raw markdown or transform meaning unpredictably?

## 6. Hidden agent layers

Check:

- Are there hidden repair, retry, summarize, or recap agents?
- Do these layers have explicit contracts and schemas?

## 7. JSON vs freeform boundary

Preferred:

- internal planning and state should be structured
- final rendering may be prose

## Severity heuristics

### critical

- confidently wrong operational behavior
- wrong actions or wrong system state with high confidence

### high

- repeated corruption of otherwise good evidence
- memory or wrapper layers repeatedly steer answers off target

### medium

- correctness often survives, but the system is fragile or hard to trust

### low

- mostly maintainability or cosmetic concerns
