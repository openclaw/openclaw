---
name: superpowers-debugging-systematic-debugging
description: Investigate bugs by proving root cause before proposing or applying fixes. Use when a test fails, behavior is wrong, or a bug report is still at the symptom stage.
---

# Systematic Debugging

Do not guess. Find the root cause first.

This skill exists to stop thrashing. A fast wrong fix is slower than a disciplined investigation that identifies the real failure point once.

## The Rule

No fix without root cause evidence.

If you cannot explain:

- what is failing
- where it starts
- why it happens

then you are not ready to fix it.

## When To Use

Use this skill for:

- failing tests
- broken features
- unexpected runtime behavior
- build or CI failures
- integration regressions
- bugs reported from logs or screenshots

Use it especially when the obvious fix feels too obvious, when multiple prior fixes failed, or when the system crosses several layers.

## Phase 1: Establish Facts

Before editing code:

1. Read the error or symptom carefully.
2. Reproduce it as narrowly as possible.
3. Record the exact command, input, or path that triggers it.
4. Check recent related changes in the codebase.

Do not collapse multiple unknowns into one story. Separate observed facts from hypotheses.

## Phase 2: Trace The Failure

Identify the failing path through the system.

- For local bugs, trace from the failing function or assertion backward to the caller and input source.
- For multi-step systems, inspect each boundary independently.
- Add temporary diagnostics only when needed to prove where the data or state goes wrong.

Useful questions:

- Where does the bad value first appear?
- What earlier layer still looks correct?
- What assumption changes between those two points?

If the bug is deep in a call stack, work backward instead of patching the leaf symptom.

## Phase 3: Compare Against Working Reality

Find a known-good comparison:

- similar code in the same repo
- adjacent test coverage
- a previous implementation path
- the documented contract for that module

Then list the differences. Small differences matter.

This phase is where many false assumptions die. Use it.

## Phase 4: State A Falsifiable Hypothesis

Write down one clear statement:

`I think <root cause> because <evidence>.`

Then test the smallest thing that could disprove it.

Good hypothesis:

- specific
- evidence-backed
- testable with one change or one additional observation

Bad hypothesis:

- broad
- stacked with several guesses
- already phrased as a fix

## Phase 5: Fix Only After Proof

Once the hypothesis survives testing:

1. Add or update a failing test if feasible.
2. Change the smallest production path that addresses the root cause.
3. Re-run the targeted test.
4. Re-run any nearby verification needed for confidence.

If the first fix attempt fails, return to investigation. Do not keep piling on changes.

If multiple fix attempts fail in different places, question the architecture instead of escalating patch size.

## Red Flags

Stop and restart the process if you catch yourself doing any of these:

- proposing a fix before reproducing
- changing several things at once
- saying "probably" without evidence
- skipping targeted verification
- assuming a stack trace already proves root cause
- treating a symptom-masking guard as a real fix

## Evidence Standard

A bug is not understood until you can point to:

- the implicated code path
- the mechanism of failure
- the verification that would fail before and pass after

For this repo, that usually means naming the file and the command that demonstrates the issue.

## Output Shape

When reporting debugging progress, structure it as:

1. Symptom
2. Reproduction
3. Root cause evidence
4. Fix plan
5. Verification

If you do not yet have root cause evidence, stop at step 2 or 3 and say so plainly.

## Related Skills

- `skills/superpowers-testing-test-driven-development/SKILL.md` for turning the bug into a regression test.
- `skills/superpowers-collaboration-writing-plans/SKILL.md` when the fix requires a multi-step plan rather than immediate edits.
