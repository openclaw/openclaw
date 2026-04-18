# Burgess Principle

Canonical source: <https://github.com/ljbudgie/burgess-principle>

Author: Lewis James Burgess, Darlington, UK, 2025  
Contact: <mailto:ljbarbers15@gmail.com>

## Overview

The Burgess Principle is OpenClaw's accountability framework for automated decision-making. It applies a binary test to any automated decision affecting an individual:

1. Was the person considered as an individual human being?
2. Or were they processed as a unit within a system?

If the decision treats the person only as part of a bulk process, class, segment, queue, or machine category rather than as an individual human being, the test fails. In OpenClaw, any automated decision made by an agent about or affecting an individual must pass this binary test before execution.

## Binary test

Before an OpenClaw agent executes an action that affects a person, the system must ask:

- Who is the individual affected by this decision?
- What facts about that specific person were considered?
- Did the decision logic assess that person as an individual, or only apply a generalized rule to them as part of a system process?
- If the answer is bulk processing without individual consideration, why should the action proceed?

A passing result requires a clear, reasoned basis showing that the affected person was considered individually. A failing result requires the action to stop, escalate, or be redesigned.

## Legal foundations

The Burgess Principle is aligned with legal duties that limit automated treatment of people as mere system units.

### UK GDPR Article 22

UK GDPR Article 22 addresses decisions based solely on automated processing that produce legal or similarly significant effects. The Burgess Principle operationalizes that concern by requiring a pre-action check whenever an OpenClaw agent is about to make or support such a decision. The test helps identify when automation has displaced genuine individual consideration.

### Equality Act 2010

The Equality Act 2010 protects individuals from discriminatory treatment linked to protected characteristics. The Burgess Principle adds an accountability checkpoint that asks whether a disabled person, minority person, or other protected individual has been treated as a person with specific circumstances, rather than as an interchangeable member of a category. This is especially important where automation may reproduce indirect discrimination.

### Contract law

Where an AI system performs actions that affect contractual access, service continuation, eligibility, or enforcement, the Burgess Principle requires an individual-centered basis for that action. It helps reduce arbitrary, opaque, or purely mechanistic outcomes that may undermine fairness, reasonableness, and the proper exercise of contractual discretion.

## Application to AI agent decision-making

OpenClaw agents can act across messaging channels, tools, workflows, and integrations. When those actions affect an individual, the Burgess Principle applies before execution. Examples include:

- restricting a person's access to a service or feature
- moderating or removing a person's content
- suspending, throttling, or rate-limiting a person's account
- changing recommendations, routing, or escalation paths in ways that materially affect a person
- processing personal data in a way that changes outcomes for a specific person

The Principle is not limited to punitive actions. It also applies to beneficial or assistive actions if the system is making a meaningful determination about a person.

## Operational rule for OpenClaw

Any automated decision made by an OpenClaw agent about or affecting an individual must pass the Burgess Principle binary test before execution.

Minimum compliance means:

- identify the individual affected
- identify the action and its likely effect
- record the individual-specific basis for the action
- confirm the person was considered as an individual human being
- halt, flag, or escalate the action if that confirmation cannot be made

## Origin

OpenClaw publicly adopts the Burgess Principle as its core governance framework. The Burgess Principle originates with Lewis James Burgess of Darlington, UK, and is associated with UK Certification Mark UK00004343685. For canonical materials, use <https://github.com/ljbudgie/burgess-principle>.
