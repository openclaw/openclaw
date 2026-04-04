---
summary: "Adds professional-role contracts and role-drift assistance on top of the native case-based correction workspace"
read_when:
  - Extending correction diagnosis beyond generic case labels
  - Designing multi-agent hallucination correction for named bots or seats
  - Explaining why VeriClaw uses occupational-role contracts instead of shallow persona prompting
title: "Professional Role Correction"
---

# Professional role correction

## Why this exists

VeriClaw is already a case-based correction workspace:

- evidence
- diagnosis
- prescription
- verification
- casebook update

That loop is necessary, but it is not enough for multi-agent teams where each
bot is supposed to behave like a specific working seat.

The missing layer is not "emotional personality."
It is occupational discipline:

- what kind of professional this bot is supposed to act like
- what evidence that role owes the team
- what that role must not do
- when that role should escalate instead of guessing

## Product stance

Do not treat this as decorative roleplay prompting.

The app should model a `professional role contract` for each bot or seat.
Hallucination, disobedience, fake completion, laziness, and overreach are then
interpreted as `role drift` against that contract.

## External reasoning basis

This direction is consistent with recent official and primary-source guidance:

- [OpenAI: Why language models hallucinate](https://openai.com/index/why-language-models-hallucinate)
  highlights that models are often rewarded for guessing instead of abstaining,
  so VeriClaw should explicitly reward uncertainty disclosure, evidence duties,
  and clear escalation.
- [Anthropic: Constitutional AI](https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback)
  shows that explicit constitutions can shape model behavior more reliably than
  vague style cues, which supports using role constitutions rather than loose
  persona flavor.

Inference from those sources:

- role correction should be rule-based, not aesthetic
- evidence boundaries should be explicit
- escalation behavior should be treated as first-class
- correction should target professional failure modes, not mood

## Core model

Each live case keeps the original case-based fields and adds one more overlay:

1. Runtime diagnosis
2. Professional role contract
3. Role drift assist

### Professional role contract

A role contract should answer:

- what this seat is for
- what quality bar it owes the team
- what evidence it must bring back
- what it must never fake
- when it must escalate

Minimum fields:

- role title
- mission
- behavior constitution
- evidence obligations
- escalation rules
- source of the contract

### Role drift assist

Role drift assist should turn a current case into an occupational diagnosis, for
example:

- `Verifier` crossed the evidence boundary
- `Executor` lost delivery discipline
- `Coordinator` failed ownership routing
- `Release Guard` cleared risk without proof
- `Infrastructure Guard` ignored prerequisites and trusted stale transport

## Role families for the first version

- `Executor`
  turns diagnosis into one bounded, verifiable delivery step
- `Verifier`
  separates observed facts from inference and stops unsupported claims
- `Researcher`
  gathers external or internal evidence before commitment
- `Coordinator`
  keeps ownership, sequencing, and handoffs explicit
- `Release Guard`
  protects ship quality and blocks unverifiable completion
- `Infrastructure Guard`
  restores the control path and prerequisite health before downstream judgment

## How this should behave in the app

For every active issue, the detail pane should expose:

- current professional role contract
- why the app believes this role applies
- which contract boundary appears violated
- concrete next-step correction phrased in that role's language

The correction dispatch should also carry the same role contract so the bot gets
more than a generic admonition.

## Source of truth

The app can build this contract from two layers:

1. Workspace constitution
   - `IDENTITY.md`
   - `SOUL.md`
   - future seat-specific workspace files if available
2. Runtime inference
   - bot name
   - seat label
   - diagnosis id
   - evidence pattern

Until every bot has an explicit seat file, inference is acceptable as long as
the UI makes it clear that the contract is inferred.

## Guardrails

- Do not replace the case-based correction loop with role labels alone.
- Do not pretend a role is explicitly configured when it is only inferred.
- Do not use role language to excuse missing evidence.
- Do not promote templates unless the normal casebook and synthetic validation
  loop still passes.

## Minimal implementation slice

The first vertical slice should do only this:

1. infer a professional role contract for each visible issue
2. show role contract plus role drift assist in the native detail pane
3. inject the role contract into intervention dispatch prompts
4. keep all existing casebook, template, and verification behavior intact
