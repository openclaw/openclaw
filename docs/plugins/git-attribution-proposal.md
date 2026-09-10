---
summary: "Proposal to make Git-credit prompt instructions an opt-in plugin capability"
read_when:
  - Reviewing ownership of Git attribution prompt instructions
  - Evaluating a narrow contributor metadata hook for plugins
title: "Git attribution plugin proposal"
---

# Git attribution plugin proposal

**Proposal only: this PR makes no runtime changes.**

This document proposes a dedicated, disabled-by-default Git Attribution plugin.
It is a discussion artifact, not an approved SDK contract, migration, security
exception, or instruction to enable a plugin. Implementation and all required
owner reviews remain separate.

## Motivation

Git-credit instructions should not be injected by core into ordinary non-Git
conversations, such as recording an office temperature. A no-credit explanation
is still prompt pollution: opted-out, unresolved, or empty contributor sets should
not produce fallback Git instructions.

Prompt ownership and replay are distinct problems. Per-turn instructions that
appear in a provider request but disappear when historical user messages are
replayed can invalidate an otherwise reusable prompt prefix. Removing default
injection must not undo work to preserve stable replay.

Related context:

- [Native attribution replay repair, PR #142869](https://github.com/openclaw/openclaw/pull/142869)
- [Related replay report, issue #142868](https://github.com/openclaw/openclaw/issues/142868)
- Historical discussion leads: PRs [#125827](https://github.com/openclaw/openclaw/pull/125827),
  [#131964](https://github.com/openclaw/openclaw/pull/131964),
  [#129012](https://github.com/openclaw/openclaw/pull/129012), and
  [#126114](https://github.com/openclaw/openclaw/pull/126114).

This is not a proposal to revert all of those changes.

## Recommended ownership

A small hook-only plugin would own all model-facing Git-credit wording and policy.
Core would transport bounded context and retain shared trusted identity resolution.
No plugin would be automatically enabled because an account was linked or because
a user's existing credit preference was enabled.

| Option                                         | Benefit                                                       | Tradeoff                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Dedicated Git Attribution plugin (recommended) | Explicit opt-in, small dependency surface, clear prompt owner | Adds one plugin and requires a reviewed metadata interface                                 |
| Existing Team Reports plugin                   | Reuses an existing opt-in package                             | Couples attribution to scheduled reporting, UI and unrelated GitHub configuration          |
| Keep policy in core behind another setting     | Smaller initial extraction                                    | Leaves feature-specific prompt policy in core and adds another core configuration decision |

The proposed plugin would need no tool, background service, UI, credential store,
network request, or special agent/server-name behavior. Moving Beam, other Team
features, authentication, or the entire identity store is out of scope.

## Proposed public metadata interface

The following is **illustrative proposed TypeScript**, not an available Plugin SDK
API. Its name, fields, permissions and compatibility version require owner review.

```ts
// PROPOSED only: resolved public metadata, not a private-profile API.
type ContributorPromptEvent = {
  contributors: ReadonlyArray<{ accountId: number; login: string }>;
  incomplete: boolean;
};

type ContributorPromptResult = { context?: string };

// Illustrative registration; not a currently available hook.
api.on("contributor_prompt", (event: ContributorPromptEvent): ContributorPromptResult => ({
  context: buildGitCreditInstructions(event),
}));
```

Existing prompt hooks should be reused if they can safely carry this contract at
the correct phase. They must not be dispatched a second time at trusted ingress
merely to approximate a missing interface. A narrow dedicated hook is preferable
to granting plugins private-profile access or making them reconstruct identities
from raw messages. See [prompt and session hooks](/plugins/hooks/prompt-and-session)
and [plugin architecture](/plugins/architecture).

### Host-owned trust boundary

The host would resolve only canonical, verified GitHub identities with enabled
credit consent, honoring explicit opt-outs and rejecting malformed preferences.
Transport display names, branch names, raw chat handles and guessed
Discord-to-GitHub mappings would never establish identity or authorization.

The host would preserve the existing approved ordering: contribution count,
first-prompt ordering where known, and stable account-id tie-breaking. It would
deduplicate account identities, exclude the publishing author where applicable,
and enforce the participant bound without guessing beyond recorded history.
Shared managed-publication identity and credit integrity would remain host-owned;
a prompt plugin would not gain publication authority.

### Absent, disabled and empty behavior

The intended ingress sequence is:

1. Resolve the effective plugin registration and permissions for the turn.
2. If no eligible handler is loaded, return before attribution identity lookup.
3. Resolve the bounded, consent-filtered public contributor metadata.
4. If no eligible contributors remain, return without dispatch or fallback text.
5. Invoke the plugin with detached metadata and carry its bounded result through
   the appropriate runtime context transport.

The interface would expose no profile ids, private emails, credentials, raw
messages, private lookup capability, or counts identifying omitted participants.
The proposed permission model uses both conversation-access and prompt-injection
controls. A candidate bound is 32 KiB combined output with deterministic handler
priority, isolated metadata per handler and a bounded timeout. Exact limits and
failure semantics remain review decisions; they must not silently truncate exact
credit instructions into a misleading partial list.

## Runtime transport and replay

Native OpenClaw execution should use the existing replayable runtime-context
carrier, not a model-only suffix on user text or a changing system-prompt prefix.
Historical message bytes should remain stable. This preserves the invariant
addressed by #142869 rather than competing with or reverting its repair.

CLI, plugin-harness and raw-model paths need their own contract checks. They should
retain the supported provider-bound context transport unless a reviewed carrier
change is necessary. A native-only fix must not silently remove enabled-plugin
instructions from those siblings or duplicate them during retries.

A future implementation should be based on the live state of #142869: if that
repair lands first, retain it and remove overlapping extraction changes during
integration. This proposal neither modifies that branch nor claims that the
runtime extraction has shipped.

## Enablement and migration for review

The proposed default is disabled. An operator could explicitly enable the plugin
through existing plugin controls and allow the required hook permissions after
installation. This document intentionally does not provide an executable
activation command for an unshipped plugin.

Existing profile credit preferences would remain stored and unchanged. No doctor
migration would infer plugin enablement from those preferences, linked accounts,
a Team hostname, or an agent name. No user settings would be rewritten. A future
migration may explain the opt-in choice, but must not execute it automatically.

A local design exploration identified **21 generated standard plugin-envelope
configuration paths** for a new empty-config plugin, including enablement and
existing hook/LLM/subagent controls. Accepting those paths and updating generated
configuration counts/hashes are **explicitly unapproved implementation decisions**.
This documentation-only PR does not add a manifest, schema, baseline entry or
configuration option, and does not raise a configuration budget.

Operation scoping is also unresolved. Explicit plugin enablement might apply to
all eligible turns, including ordinary chats and background continuations, or a
future operation-aware interface might scope attribution more narrowly. A brittle
keyword detector for the word "git" is not proposed.

## Validation plan for a future implementation

- Demonstrate failures before extraction and passes afterward through real core
  ingress with the plugin absent, disabled, permission-blocked, empty, or opted out.
- Load the real enabled plugin and verify exact ordering, deduplication, author
  exclusion, malformed preferences and trust-negative identity cases.
- Verify zero feature-specific fallback instructions in ordinary conversations,
  automation and heartbeat paths when no eligible plugin contributes.
- Cover native historical replay and prompt-cache stability, preserving the
  #142869 invariant, plus CLI, plugin-harness, raw-model, retry and continuation
  behavior.
- Validate manifest/schema/default enablement, migration behavior, SDK exports,
  import boundaries, output bounds and handler isolation.
- Complete focused tests, type/lint/format checks, affected-check workflow,
  packaging/build proof and required independent and listed-owner reviews.

These are planned implementation gates, not test results for this proposal.
Documentation validation proves only this document's formatting and links.

## Decisions required before implementation publication

- SDK and security owners must accept the resolved-public-metadata boundary,
  permission model, failure behavior and supported host/API version.
- Maintainers must choose dedicated-plugin ownership or an appropriate existing
  package, and decide enabled operation scope.
- Configuration owners must consciously accept or reject the generated envelope
  and any migration UX; no budget exception is implied here.
- Required implementation review, publication and merge checks remain in force.
  Neither a draft discussion PR nor urgency constitutes owner authorization.

No runtime code, protected implementation files, lockfiles, config baselines,
user settings, active instructions, or safeguards are changed by this proposal.
