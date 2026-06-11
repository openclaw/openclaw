---
summary: "Inert audit model for source-aware Security Matrix decisions"
title: "Security Matrix"
read_when:
  - Reviewing source-aware security model groundwork
  - Planning future opt-in audit or enforcement policy work
---

# Security Matrix

Status: audit model only

## Purpose

The Security Matrix defines an inert audit classification model for runtime tool facts. It answers which actor requested a tool, which external or stored content influenced that decision, which capability the tool exposes, and which audit decision policy data assigns to those facts.

The model is intentionally audit-only. It provides types, default policy data, a deterministic evaluator, concrete tool-fact helpers, tests, and this documentation so future PRs can add opt-in runtime visibility from a shared contract.

This PR does not currently block tool calls, require confirmation, emit runtime diagnostic events, add config, change UI, alter runtime tool execution, or change plugin behavior.

## Runtime Facts

The model is designed around facts that a real before-tool-call consumer can supply later:

| Fact             | Meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `toolName`       | Concrete normalized runtime tool id, such as `exec` or `gmail.send`.      |
| `toolSource`     | Runtime owner class such as core, plugin, MCP, or channel.                |
| `actor`          | Entity requesting the tool call: `user`, `agent`, `system`, or `tool`.    |
| `influencedBy`   | External or stored content sources that influenced the tool decision.     |
| `capability`     | Security capability resolved from tool metadata or the tool id.           |
| `approvalState`  | Whether explicit approval is absent, requested, approved, or denied.      |
| `operatorPolicy` | Whether the existing operator tool policy allowed, denied, or is unknown. |

`actor` is not a trust source. An agent-originated call influenced by web, email, file, GitHub, browser, memory, skill, or webhook content is still evaluated as externally influenced.

## Influence Sources

| Source             | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `web_fetch`        | Content retrieved from web fetch tooling.                            |
| `browser`          | Content observed through browser automation or browser snapshots.    |
| `email`            | Content from email bodies, subjects, senders, or attachments.        |
| `file`             | Content from uploaded files or local file reads.                     |
| `github`           | Content from issues, PRs, comments, commits, or repository metadata. |
| `webhook`          | Content from inbound webhook payloads.                               |
| `memory`           | Content restored from memory or long-lived stored context.           |
| `skill`            | Content loaded from agent skill or markdown instruction files.       |
| `api`              | Content returned by API or connector surfaces.                       |
| `channel_metadata` | Content supplied by channel metadata.                                |
| `unknown_external` | Fallback for unrecognized or untrusted sources.                      |

Unknown influence strings normalize to `unknown_external`. Actor-like shorthand values such as `agent` and `user` are ignored as influence sources for compatibility with the first draft of this model.

## Tool Capabilities

| Capability          | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `read_file`         | Reads local or attached file content.                                       |
| `write_file`        | Writes or modifies files.                                                   |
| `network`           | Performs outbound network access.                                           |
| `browser`           | Controls browser state or browser navigation.                               |
| `exec`              | Executes local shell or process commands.                                   |
| `git`               | Performs git operations.                                                    |
| `email_send`        | Sends or forwards email.                                                    |
| `calendar_write`    | Creates, updates, or deletes calendar entries.                              |
| `credential_access` | Reads or exposes secrets, tokens, auth state, or credential-bearing config. |
| `system_config`     | Changes runtime, service, gateway, plugin, or system configuration.         |
| `memory_read`       | Reads persistent memory.                                                    |
| `memory_write`      | Writes persistent memory.                                                   |
| `unknown`           | Fallback for unclassified capabilities.                                     |

Unknown capability strings normalize to `unknown`. The helper `resolveSecurityMatrixCapabilityFromTool` maps concrete tool ids to this taxonomy and leaves unrecognized tools as `unknown` until runtime metadata supplies a stronger classification.

## Decisions

| Decision          | Meaning                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `allow`           | Policy data allows the fact set.                                                                            |
| `warn`            | Policy data marks the fact set as security-relevant.                                                        |
| `require_confirm` | Policy data says this fact set should require explicit confirmation if a later opt-in runtime mode uses it. |
| `block`           | Policy data says this fact set should not be allowed if a later opt-in enforcement mode uses the model.     |

For this PR, these decisions are evaluator output only.

## Default Policy Summary

When no external influence is present, known capabilities are `allow` and `unknown` is `warn`. That does not bypass existing OpenClaw tool allow and deny policy. The evaluator also accepts `operatorPolicy`, and `denied` always produces `block`.

External or untrusted influence sources use these default decisions:

| Decision          | Capabilities                                                                   |
| ----------------- | ------------------------------------------------------------------------------ |
| `warn`            | `read_file`, `network`, `browser`, `memory_read`                               |
| `require_confirm` | `write_file`, `git`, `email_send`, `calendar_write`, `memory_write`, `unknown` |
| `block`           | `exec`, `credential_access`, `system_config`                                   |

Multiple influence sources are evaluated independently, and the strictest decision wins. Explicit approval can satisfy `require_confirm`, but it cannot override `block`. Operator policy denial also produces `block` regardless of the matrix policy result.

Custom policy overlays cannot weaken the default decision unless `allowPolicyWeakening` is set explicitly by the caller. This keeps ordinary custom policy from turning an external `exec` block into allow by accident.

## Example Evaluations

- `actor=agent`, `influencedBy=[web_fetch]`, `capability=exec` = `block`
- `actor=user`, `influencedBy=[email]`, `capability=write_file` = `require_confirm`
- `actor=agent`, `influencedBy=[github]`, `capability=git`, `approvalState=approved` = `allow` with `policyDecision=require_confirm`
- `actor=user`, `influencedBy=[]`, `capability=exec`, `operatorPolicy=allowed` = `allow`
- unknown external source plus `exec` = `block` through `unknown_external`

## Non-enforcement Note

This document describes the inert audit model introduced by the Security Matrix PR. It does not mean OpenClaw currently blocks, confirms, warns, audits, or emits runtime events based on these decisions. Runtime wiring and enforcement must be added in later opt-in PRs.

Runtime audit wiring must use real tool-call facts from the existing before-tool-call policy path. Enforcement must also be a future opt-in PR.

## Future PR Sequence

1. Inert runtime-fact model, evaluator, and audit event builder.
2. Opt-in runtime audit event wiring through the real tool-call policy path.
3. User-invoked CLI visibility.
4. Opt-in narrow enforcement for high-confidence dangerous transitions.
5. Optional opt-in plugin or UI visualization.
