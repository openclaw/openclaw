# Burgess Principle Check agent

Canonical source: <https://github.com/ljbudgie/burgess-principle>

Author: Lewis James Burgess, Darlington, UK, 2025  
Contact: <mailto:ljbarbers15@gmail.com>

## Purpose

The Burgess Principle Check agent turns the Burgess Principle binary test into a callable tool inside the OpenClaw ecosystem.

It accepts a description of an automated decision and returns:

- pass or fail
- reasoning
- recommended remediation if failed

## Philosophical basis

The tool encodes a simple governance question: was the affected person considered as an individual human being, or were they processed as a unit within a system?

That question is the core of the Burgess Principle and the reason it functions as an accountability layer rather than a mere policy label. The aim is not just to classify risk, but to stop impersonal automation from acting on people without individual consideration.

## Usage example

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

Possible output:

```json
{
  "result": "pass",
  "reasoning": "The proposed action includes person-specific facts and an explainable basis tied to this individual rather than only a bulk threshold.",
  "recommendedRemediation": "Proceed with audit logging and preserve the reviewed facts."
}
```

Failed-case output:

```json
{
  "result": "fail",
  "reasoning": "The decision is based only on a generalized risk threshold and does not show individual-specific consideration.",
  "recommendedRemediation": "Halt the action, flag it for review, and gather person-specific context before retrying."
}
```

## Integration patterns

Use this agent immediately before any automated action that affects an individual.

Common integration points:

- moderation pipelines
- account enforcement flows
- recommendation and ranking systems
- data-routing or prioritization workflows
- accessibility or assistive workflows affecting a specific person

Recommended pattern:

1. Build the action proposal.
2. Call the Burgess Principle Check agent.
3. Execute only if the result is pass.
4. If failed, halt and surface the remediation guidance.

## OpenClaw role

Within OpenClaw, this agent provides a reusable governance checkpoint that developers can attach to agent workflows, tools, and automations. For canonical materials and updates, use <https://github.com/ljbudgie/burgess-principle>.
