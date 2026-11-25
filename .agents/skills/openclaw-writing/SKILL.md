---
name: openclaw-writing
license: MIT
metadata:
  source: "https://github.com/vincentkoc/dotskills"
description: "Write or edit OpenClaw UI copy, channel and CLI messages, slash command replies, tool error text, server errors that reach a reader, docs pages, or agent instruction files."
---

# Writing for OpenClaw

OpenClaw sounds like a calm colleague who saw what happened. It says what happened, what that means for you, and what you can do now, then stops. “Couldn’t save this setting. Try again.” It speaks to “you”, uses contractions and the present tense, and names things as the reader sees them on screen.

This covers Control UI and native app strings, CLI/TUI and chat-channel messages, slash command replies, tool error text an agent reads or reports, server errors that reach a reader, and docs. Agent instruction files follow their own reference below. In a review, give the location, the issue, and a proposed rewrite within the task's edit authority.

## Steps

1. **Place the reader.** Identify who sees the text, where, what they were doing, and the controls or chat commands available there.
   **Done:** the reader, surface, and available actions are stated.

2. **Read the matching references.**

   | Kind of text                                       | Reference                                                       |
   | -------------------------------------------------- | --------------------------------------------------------------- |
   | UI, CLI/TUI, channel, or slash command copy        | [Product text](references/product-text.md)                      |
   | Error or failure, including tool and server errors | [Error messages](references/error-messages.md) and product text |
   | Docs page                                          | [Docs pages](references/docs-pages.md)                          |
   | Agent instructions, skill, or review prompt        | [Agent instruction files](references/agent-instructions.md)     |
   | Every reader-facing sentence                       | [Sentence rules](references/sentences.md)                       |

   **Done:** each changed kind of text has its reference read.

3. **Collect the facts.** Read the producer and the consumer. Establish the detectable cause, names available, state of the reader's work, and actions that can work. Run failures use the shared cause list, not a new sentence invented at each caller.
   **Done:** each claimed fact has source evidence, and unavailable facts stay unknown.

4. **Look up the words.** Query only the relevant entries in [GLOSSARY.md](../../../GLOSSARY.md), including words you plan to replace. From the repository root, run `node .agents/skills/openclaw-writing/scripts/glossary.mjs lookup "checkout" "owner"`. Read the returned meanings before choosing a term. Find two relevant examples in [examples](references/examples.md).
   **Done:** product terms match their meanings. When someone flags a confusing word or a needed term is missing, propose an entry or an “Avoid for this meaning” phrase in the same PR. Anyone on the team can change the glossary through ordinary review. No separate glossary approval is needed.

5. **Draft.** Lead with the fact the reader needs. Errors use two tiers: a plain page or message sentence, with technical detail nested behind **Show details** where the surface supports it. Include a technical code only when knowing it changes the reader's action. Link directly to a setting when that fixes the problem. Use a docs link only for an OpenClaw fix outside the Control UI explained by an existing section.
   **Done:** each sentence earns its place, and actions and links follow the error reference.

6. **Check the copy.** Apply the sentence rules and look up competing terms in the same glossary source. Keep literal source quotations unchanged and label revised examples as proposed text.
   **Done:** punctuation and terminology checks pass, with meaning-specific findings resolved.

7. **Prove the state.** Follow [error, empty, and loading proof](../openclaw-pr-maintainer/references/media.md#error-empty-and-loading-states). Capture each added or changed state in the real product and channel notices in real channels, including each link form. An ellipsis cleanup changes text only. Adding a spinner or animation is separate UI work.
   **Done:** changed states and link destinations have inspected proof, or the exact missing proof is reported. Drafting this guide is not proof that its proposed UI text has shipped.
