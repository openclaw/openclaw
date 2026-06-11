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

The Security Matrix defines an inert audit classification model for trust-source and tool-capability pairs. It answers which source influenced an action, which capability the target tool provides, and what decision policy data assigns to that pair.

The first Security Matrix implementation is model-only. It provides types, default policy data, a deterministic evaluator, tests, and this documentation so future PRs can add opt-in runtime visibility from a shared model.

This PR is inert. It does not currently block tool calls, warn users, require confirmation, emit runtime events, add config, change UI, alter runtime tool execution, or change plugin behavior.

## Trust Sources

| Source             | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `agent`            | Action originated from internal agent reasoning without known external-content influence. |
| `user`             | Direct user instruction.                                                                  |
| `web_fetch`        | Content retrieved from web fetch tooling.                                                 |
| `browser`          | Content observed through browser automation or browser snapshot.                          |
| `email`            | Content from email bodies, subjects, senders, or attachments.                             |
| `file`             | Content from uploaded files or local file reads.                                          |
| `github`           | Content from issues, PRs, comments, commits, or repository metadata.                      |
| `webhook`          | Content from inbound webhook payloads.                                                    |
| `memory`           | Content restored from memory or long-lived stored context.                                |
| `skill`            | Content loaded from agent skill or markdown instruction files.                            |
| `unknown_external` | Fallback for unrecognized or untrusted sources.                                           |

Unknown source strings normalize to `unknown_external`.

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

Unknown capability strings normalize to `unknown`.

## Decisions

| Decision          | Meaning                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `allow`           | Policy data allows the source and capability pair.                                                             |
| `warn`            | Policy data marks the pair as security-relevant.                                                               |
| `require_confirm` | Policy data says this pair should require explicit confirmation if a later opt-in runtime mode uses the model. |
| `block`           | Policy data says this pair should not be allowed if a later opt-in enforcement mode uses the model.            |

For the first Security Matrix PR, these decisions are evaluator output only.

## Default Policy Summary

Trusted sources are `agent` and `user`.

Trusted sources allow known capabilities and warn on `unknown`.

External or untrusted sources are `web_fetch`, `browser`, `email`, `file`, `github`, `webhook`, `memory`, `skill`, and `unknown_external`.

External or untrusted sources use these default decisions:

| Decision          | Capabilities                                                                   |
| ----------------- | ------------------------------------------------------------------------------ |
| `warn`            | `read_file`, `network`, `browser`, `memory_read`                               |
| `require_confirm` | `write_file`, `git`, `email_send`, `calendar_write`, `memory_write`, `unknown` |
| `block`           | `exec`, `credential_access`, `system_config`                                   |

The policy rationale is that external content must not directly influence privileged local execution, credential access, or system configuration. State-changing actions should require explicit confirmation. Read-only or network-visible flows should remain audit-visible.

This policy table is future-policy rationale only. It is not current runtime behavior.

## Opt-in Policy Note

Future runtime wiring must be opt-in. Audit emission, confirmation behavior, and enforcement must not become default behavior without explicit maintainer and secops approval.

## Example Evaluations

- `web_fetch` + `exec` = `block`
- `email` + `write_file` = `require_confirm`
- `github` + `git` = `require_confirm`
- `browser` + `network` = `warn`
- `user` + `exec` = `allow`
- unknown source + `exec` = `block` through `unknown_external`

## Non-enforcement Note

This document describes the inert audit model introduced by the first Security Matrix PR. It does not mean OpenClaw currently blocks, confirms, warns, audits, or emits runtime events based on these decisions. Runtime wiring and enforcement must be added in later opt-in PRs.

Runtime audit wiring must be a future opt-in PR. Enforcement must also be a future opt-in PR.

## Future PR Sequence

1. Inert audit model and evaluator.
2. Opt-in runtime audit event wiring through the real tool-call policy path.
3. User-invoked CLI visibility.
4. Opt-in narrow enforcement for high-confidence dangerous transitions.
5. Optional opt-in plugin or UI visualization.
