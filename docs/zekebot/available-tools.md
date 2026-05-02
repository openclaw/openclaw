---
summary: "Native ZekeBot tools and profile availability."
read_when:
  - Auditing the model-facing ZekeBot catalog
  - Checking why a tool is or is not visible
title: "Available ZekeBot tools"
---

# Available ZekeBot Tools

Native ZekeBot tools are OpenClaw plugin tools backed by ZekeFlow authority APIs. The model sees the tool schema in OpenClaw, but ZekeFlow decides whether the call is allowed and performs the stateful work.

| Tool                         | Purpose                                                  | Sprout | Rambo | External |
| ---------------------------- | -------------------------------------------------------- | -----: | ----: | -------: |
| `ask_zeke_context`           | Answer from cited Zeke evidence.                         |    yes |   yes |       no |
| `search_zeke_context`        | Return matching context evidence.                        |    yes |   yes |       no |
| `explain_zeke_context_route` | Explain which context route would answer a query.        |    yes |   yes |       no |
| `read_zeke_source`           | Read an approved source reference.                       |    yes |   yes |       no |
| `read_repo_file`             | Read bounded repo files through ZekeFlow policy.         |    yes |    no |       no |
| `grep_repo`                  | Search bounded repo text through ZekeFlow policy.        |    yes |    no |       no |
| `glob_repo`                  | List bounded repo paths through ZekeFlow policy.         |    yes |    no |       no |
| `propose_signal`             | Create a pending signal proposal for same-chat approval. |    yes |    no |       no |

## Backend-only tools

`create_signal` is backend-only. If it appears in a model-facing catalog, treat that as a boundary bug and stop the rollout.

## Audit and ownership

ZekeFlow owns durable audit and approval state. The generic `ops:zekebot.tool_call` envelope is planned; until it ships, rely on the specific ZekeFlow events emitted by the called capability and on the approval records for `propose_signal`.
