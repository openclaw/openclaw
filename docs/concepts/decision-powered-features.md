---
summary: "Implemented Decision-model consumers, opt-ins, evidence, and fallback behavior"
title: "Decision-powered features"
read_when:
  - You want to know which features use the configured Decision model
  - You are enabling automatic Decision assistance
  - You need to understand evidence transfer and fallback behavior
---

# Decision-powered features

This index lists connected product consumers of the Decision model role, not
hypothetical uses of classification. [Decision models](/concepts/decision-models)
owns provider setup, model selection, and the shared typed evaluation API. A
Decision model does not replace the conversational model or grant permission to
perform an action.

| Feature                                                                | When it evaluates                                                            | Required opt-in                                                                                                                                              | Evidence and result                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Auto steering](/concepts/queue-steering#auto-steering)                | An ordinary human Control UI text message arrives during an active main turn | Decision assistance in Labs, an effective owning-agent Decision model, the enabled Auto plugin with conversation access, and the browser **Auto** preference | Bounded visible current-turn text plus the whole new message; advice selects steering or follow-up, while the Gateway retains authorization and delivery ownership |
| [Explicit evaluation](/concepts/decision-models#agent-evaluation-tool) | The agent calls `decision_evaluate`                                          | An effective Decision model and normal tool/harness policy; **not** Labs                                                                                     | Only the supplied state and rubric; a typed result returned to the agent, not permission for a later action                                                        |

## Setup and defaults

Configure a [provider](/concepts/decision-models#choose-a-provider-and-model), then
select its model in the Control UI **Decision** picker globally or for the owning
agent. An unset agent override inherits the global selection; an explicit empty
override disables this role for that agent. Selection alone starts no inference.

Automatic features additionally require
[Decision assistance](/concepts/experimental-features#decision-assistance), which
is off by default. Auto is separately off by default and appears below **Fast**
in the native effort picker. Its shuffle icon and browser preference are separate
from Fast mode and reasoning effort. Disabling the plugin or its conversation
access hides Auto without clearing its saved preference or manual delivery mode.

A saved selection does not provision credentials, download local artifacts, or
guarantee provider readiness. Auto does not depend on a particular provider; use a compatible configured
Decision provider.

## Evidence, cost, and fallback

Auto sends bounded, credential-redacted visible context to the selected provider.
It excludes hidden reasoning, tool output, incognito input, attachments, quoted
replies, and commands. Redaction is not anonymization: visible conversation text
can still contain private information. Hosted inference may incur provider
charges; a local provider needs its own supported artifacts or service.

One 500 ms optional-work budget covers preparation and advice. This is not an
end-to-end send latency guarantee. Unavailable or ineligible advice, abstention,
and deadline expiry preserve the captured manual/server baseline. Auto does not
split or rewrite a message, retry another model, or retarget a successor run.
Explicit controls retain their normal behavior; cancellation and lost authority
are not instructions to launch a late fallback task.

An Auto routing choice is not proof of consumption. Only the normal delivery
owner can confirm **Steered**. See [Queue and steering](/concepts/queue-steering)
for exact bounds, ordering, cancellation, and delivery semantics.

## Other plugin consumers

Plugins can call the [typed Decision API](/concepts/decision-models#call-from-a-plugin)
under their normal authority and lifecycle. API availability alone schedules no
background work. Add each new connected product consumer to this index with its
actual opt-in, evidence transfer, and failure behavior. Provider setup tools and
model-catalog listings are not additional automatic features.
