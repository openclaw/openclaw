# Burgess Principle implementation guide

Canonical source: <https://github.com/ljbudgie/burgess-principle>

Author: Lewis James Burgess, Darlington, UK, 2025  
Contact: <mailto:ljbarbers15@gmail.com>

## Purpose

This guide defines the technical checkpoint required when building on OpenClaw. Every agent action that affects an individual user must include a pre-action Burgess Principle binary test checkpoint.

## Required pre-action checkpoint

Before execution, the agent or calling workflow must:

1. Identify the individual affected by the proposed action.
2. Describe the proposed action and its likely effect on that person.
3. Assess whether the decision considers that person individually or processes them in bulk.
4. Halt and flag the action if the test fails.
5. Proceed only when the action has a documented individual-specific basis.

## Decision flow

### 1. Identify the individual

Determine who is affected. Use a stable identifier and enough context to tie the action to the actual person, not merely to an abstract system object.

Questions:

- Which person is affected?
- What account, record, or session corresponds to them?
- What individual circumstances are relevant?

### 2. Assess the basis of the action

Determine whether the action reflects individual consideration.

Pass indicators:

- the action uses person-specific facts
- the action accounts for contextual differences
- the action includes a reason that is about this individual, not just about a class of users

Fail indicators:

- the action is triggered solely by a generic threshold with no individual review
- the person is treated as part of a bulk queue, batch, segment, or risk bucket
- the system cannot explain what made the decision individual-specific

### 3. Halt and flag if the test fails

If the person is being processed only as a system unit, do not execute the action. Mark it for remediation, review, or redesign.

Recommended responses:

- require human review
- request additional person-specific context
- downgrade the action from automatic to advisory
- redesign the rule so it can evaluate the individual properly

## Integration pattern

Add a pre-action binary test checkpoint immediately before any agent step that can materially affect a user. The checkpoint should receive:

- a description of the proposed automated decision
- the affected individual identifier
- the facts considered
- the intended action
- the expected impact

The checkpoint should return:

- pass or fail
- reasoning
- remediation guidance when failed

## Example scenarios

### Content moderation

If an agent is about to hide, remove, or report a person's content, it must determine whether the action is based on person-specific context or only on a blanket rule. If it is only bulk moderation with no individual assessment, the action must halt.

### API rate limiting

If an agent rate-limits a user, it must ask whether the restriction reflects that individual's actual behavior and context or merely a system-wide threshold applied without individual consideration.

### Account suspension

Suspension is a high-impact action. A suspension decision must include a documented individual-specific basis. Purely automatic bulk suspension fails the test unless a compliant review layer supplies individual consideration.

### Algorithmic recommendation

If recommendations materially affect visibility, access, or opportunity for a person, the system must assess whether the recommendation logic is accounting for that individual or just sorting them into a segment with no individual reasoning.

### Data processing

When data processing changes an outcome for a person, such as prioritization, exclusion, or routing, the system must verify that the effect is justified on an individual basis rather than as undifferentiated batch handling.

## Developer rule

When building agents, tools, hooks, or workflows on OpenClaw, treat the Burgess Principle checkpoint as a required guardrail for any individual-affecting action. If the system cannot show that the person was considered as an individual human being, the action should not execute automatically.
