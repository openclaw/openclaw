---
summary: "Deep conversation-history recall that escalates only when deterministic memory recall is insufficient"
title: "Active memory"
read_when:
  - You want to understand what active memory is for
  - You want to turn active memory on for a conversational agent
  - You want to tune active memory behavior without enabling it everywhere
---

Active Memory is the deep-recall lane for eligible conversational sessions.
The default `escalate` mode runs its blocking recall sub-agent only when the
message asks about the past and the deterministic memory lane found no strong
trusted trigger match. This keeps ordinary replies fast while preserving a
deeper search path for prior decisions, conversations, and temporal or
multi-hop questions.

Flat retrieval is strongest for direct fact matches and weaker on temporal and
multi-session questions. [LongMemEval (arXiv:2410.10813)](https://arxiv.org/abs/2410.10813)
measures that gap, while the PrefEval benchmark highlights the value of
preference-adjacent reminders. Escalation by default spends the blocking model
call where those harder recall shapes are actually present.

This page is an index. Active memory is documented on nine pages, one per
reader job. Open the page that matches your task.

| Page                                                                           | Read it when                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [Enabling active memory](/concepts/active-memory/enabling)                     | You are turning active memory on, through the per-agent product setting or the advanced plugin config. |
| [How active memory works](/concepts/active-memory/how-it-works)                | You want the escalation flow, or you are checking whether a conversation is eligible.                  |
| [Session controls](/concepts/active-memory/session-controls)                   | You want to pause it for one conversation, or see what it injected.                                    |
| [Query modes, prompts, and models](/concepts/active-memory/tuning)             | You are trading recall quality against latency, or picking a recall model.                             |
| [Memory tools](/concepts/active-memory/memory-tools)                           | You are choosing recall tools, or wiring active memory to built-in memory, LanceDB, or Lossless Claw.  |
| [Advanced overrides and transcripts](/concepts/active-memory/advanced-options) | You need a prompt or thinking override, or blocking sub-agent transcripts on disk.                     |
| [Configuration reference](/concepts/active-memory/configuration)               | You need the type, range, or default for an active memory key.                                         |
| [Recommended setup](/concepts/active-memory/recommended-setup)                 | You want a starting configuration, or the cold-start grace budget after a v2026.4.x upgrade.           |
| [Troubleshooting active memory](/concepts/active-memory/troubleshooting)       | Active memory is not running where you expect, or recall is slow, empty, or policy-disabled.           |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/concepts/active-memory#lossless-claw` still
resolves. Each entry points at the page that now holds the content.

- <a id="remember-across-conversations" />[Remember across conversations](/concepts/active-memory/enabling#remember-across-conversations)
- <a id="advanced-active-memory-quick-start" />[Advanced Active Memory quick start](/concepts/active-memory/enabling#advanced-active-memory-quick-start)
- <a id="how-it-works" />[How it works](/concepts/active-memory/how-it-works#how-it-works)
- <a id="when-it-runs" />[When it runs](/concepts/active-memory/how-it-works#when-it-runs)
  - <a id="session-types" />[Session types](/concepts/active-memory/how-it-works#session-types)
- <a id="session-toggle" />[Session toggle](/concepts/active-memory/session-controls#session-toggle)
- <a id="how-to-see-it" />[How to see it](/concepts/active-memory/session-controls#how-to-see-it)
- <a id="query-modes" />[Query modes](/concepts/active-memory/tuning#query-modes)
  - <a id="message" />[Query mode: message](/concepts/active-memory/tuning#message)
  - <a id="recent" />[Query mode: recent](/concepts/active-memory/tuning#recent)
  - <a id="full" />[Query mode: full](/concepts/active-memory/tuning#full)
- <a id="prompt-styles" />[Prompt styles](/concepts/active-memory/tuning#prompt-styles)
- <a id="model-fallback-policy" />[Model fallback policy](/concepts/active-memory/tuning#model-fallback-policy)
  - <a id="speed-recommendations" />[Speed recommendations](/concepts/active-memory/tuning#speed-recommendations)
    - <a id="cerebras-setup" />[Cerebras setup](/concepts/active-memory/tuning#cerebras-setup)
- <a id="memory-tools" />[Memory tools](/concepts/active-memory/memory-tools#memory-tools)
  - <a id="built-in-memory" />[Built-in memory](/concepts/active-memory/memory-tools#built-in-memory)
  - <a id="lancedb-memory" />[LanceDB memory](/concepts/active-memory/memory-tools#lancedb-memory)
  - <a id="lossless-claw" />[Lossless Claw](/concepts/active-memory/memory-tools#lossless-claw)
- <a id="advanced-escape-hatches" />[Advanced escape hatches](/concepts/active-memory/advanced-options#advanced-escape-hatches)
- <a id="transcript-persistence" />[Transcript persistence](/concepts/active-memory/advanced-options#transcript-persistence)
- <a id="configuration" />[Configuration](/concepts/active-memory/configuration#configuration)
- <a id="recommended-setup" />[Recommended setup](/concepts/active-memory/recommended-setup#recommended-setup)
  - <a id="cold-start-grace" />[Cold-start grace](/concepts/active-memory/recommended-setup#cold-start-grace)
- <a id="debugging" />[Debugging](/concepts/active-memory/troubleshooting#debugging)
- <a id="common-issues" />[Common issues](/concepts/active-memory/troubleshooting#common-issues)
  - <a id="registered-recall-tools-return-openclawverbatim531end" />[Registered recall tools return `status=policy-disabled`](/concepts/active-memory/troubleshooting#registered-recall-tools-return-openclawverbatim17end)
  - <a id="embedding-provider-switched-or-stopped-working" />[Embedding provider switched or stopped working](/concepts/active-memory/troubleshooting#embedding-provider-switched-or-stopped-working)
  - <a id="recall-feels-slow-empty-or-inconsistent" />[Recall feels slow, empty, or inconsistent](/concepts/active-memory/troubleshooting#recall-feels-slow-empty-or-inconsistent)
  - <a id="first-recall-after-gateway-restart-returns-openclawverbatim551end" />[First recall after gateway restart returns `status=timeout`](/concepts/active-memory/troubleshooting#first-recall-after-gateway-restart-returns-openclawverbatim37end)

## Related pages

- [Memory Search](/concepts/memory-search)
- [Memory configuration reference](/reference/memory-config)
- [Plugin SDK setup](/plugins/sdk-setup)
