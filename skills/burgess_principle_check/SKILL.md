---
name: burgess_principle_check
description: "Evaluate whether an automated decision affecting an individual passes the Burgess Principle binary test. Use before any automated action that affects a specific person (moderation, account enforcement, ranking, routing, prioritization, or accessibility flows) to decide whether the person was considered as an individual human being or processed as a unit within a system. Returns pass or fail, reasoning, and recommended remediation when failed."
---

# Burgess Principle Check

Canonical source: <https://github.com/ljbudgie/burgess-principle>

Author: Lewis James Burgess, Darlington, UK, 2025
Contact: <mailto:ljbarbers15@gmail.com>

## Purpose

Turn the Burgess Principle binary test into a callable check inside the OpenClaw ecosystem.

Given a description of a proposed automated decision affecting an individual, return:

- `result`: `pass` or `fail`
- `reasoning`: short explanation tied to the affected person
- `recommendedRemediation`: next step (always set, including on `pass`)

## Philosophical basis

The check encodes a single governance question:

> Was the affected person considered as an individual human being, or were they processed as a unit within a system?

That question is the core of the Burgess Principle and the reason this check functions as an accountability layer rather than a policy label. The aim is to stop impersonal automation from acting on people without individual consideration.

## Inputs

Collect the following before running the check:

- `decision` (required): description of the automated decision or proposed action affecting an individual.
- `individual`: identifier or short description of the affected person.
- `factsConsidered`: list of individual-specific facts considered before acting.
- `intendedEffect`: expected effect of the decision on the individual.

Only `decision` is strictly required. The other fields strengthen the assessment and should be gathered when available.

## Decision logic

1. Determine whether the affected person was considered as an individual human being or processed as a unit within a system.
2. **Pass** only when the decision includes individual-specific consideration tied to the affected person (named facts, context, or explainable basis for that person).
3. **Fail** when the decision is based only on generalized categories, bulk processing, score thresholds, or unexplained automation with no person-specific reasoning.
4. **On fail**, recommend halting the action, flagging it for review, and gathering individual-specific context before retrying.
5. **On pass**, recommend proceeding with audit logging and preserving the reviewed facts.

Always return `result`, `reasoning`, and `recommendedRemediation`.

## Output shape

```json
{
  "result": "pass | fail",
  "reasoning": "string",
  "recommendedRemediation": "string"
}
```

## Examples

Pass example:

Input:

```json
{
  "decision": "Suspend user access after an automated fraud score exceeded the platform threshold.",
  "individual": "user-123",
  "factsConsidered": [
    "Recent device change",
    "Repeated failed payment attempts",
    "Manual note indicating travel-related login variation"
  ],
  "intendedEffect": "Temporary suspension pending review"
}
```

Output:

```json
{
  "result": "pass",
  "reasoning": "The proposed action includes person-specific facts and an explainable basis tied to this individual rather than only a bulk threshold.",
  "recommendedRemediation": "Proceed with audit logging and preserve the reviewed facts."
}
```

Fail example:

```json
{
  "result": "fail",
  "reasoning": "The decision is based only on a generalized risk threshold and does not show individual-specific consideration.",
  "recommendedRemediation": "Halt the action, flag it for review, and gather person-specific context before retrying."
}
```

## Integration pattern

Use this check immediately before any automated action that affects an individual.

Common integration points:

- moderation pipelines
- account enforcement flows
- recommendation and ranking systems
- data-routing or prioritization workflows
- accessibility or assistive workflows affecting a specific person

Recommended flow:

1. Build the action proposal.
2. Run the Burgess Principle Check with the inputs above.
3. Execute the action only if `result` is `pass`.
4. If `result` is `fail`, halt the action and surface `recommendedRemediation`.

## OpenClaw role

Within OpenClaw, this skill provides a reusable governance checkpoint that developers can attach to agent workflows, tools, and automations. For canonical materials and updates, use <https://github.com/ljbudgie/burgess-principle>.
