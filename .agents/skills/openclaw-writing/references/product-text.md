# Product text

Reference for Control UI and native app strings, CLI/TUI output, slash command replies, and channel messages. For error, failure, tool, or server text that reaches a reader, also read [error messages](error-messages.md).

## The reader

A person in the Control UI has the controls around the sentence. A person in a channel may have only this message on a phone. A tool result reaches an agent first, but the agent needs the same clear cause and available actions to report it accurately. Keep diagnostic evidence separate from the reader-facing sentence.

## Shapes

[Examples](examples.md) distinguishes exact existing copy from proposed revisions.

| Kind                | Shape                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| Error               | A plain sentence naming the known cause and its effect. Follow the error reference for recovery.          |
| Empty state         | State what is absent, then how it gets here. An empty result is different from work still loading.        |
| Confirmation title  | The action as a question, with the thing named: Delete “{session}”?                                       |
| Confirmation body   | What goes, what stays, and what happens first.                                                            |
| In progress         | Name the work: “Saving” or “Waiting for your app”. Loading indication belongs to the UI, not punctuation. |
| Done                | The thing, then what happened to it: “API key saved.”                                                     |
| Button              | A verb, or a verb and a noun, in sentence case. Use the dialog title's verb.                              |
| Setting description | What turning it on does, then relevant limits or defaults.                                                |
| Help text           | Answer the question the reader has at that spot.                                                          |

Removing ellipses is a copy-only change. Preserve the existing loading behavior. New spinners and animations are separate UI work, not part of the punctuation cleanup.

## Settings and recovery links

For an error, choose the destination by where the fix is:

| Fix                                                                        | Destination                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| An OpenClaw setting                                                        | The exact setting, not a docs page.                                                                    |
| An OpenClaw fix outside the Control UI, such as paired-device or CLI setup | An existing docs section that explains that fix.                                                       |
| Provider-side problem, or neither of the above                             | The sentence alone. An available local recovery action can still be offered under the error reference. |

The destination resolver supplies a reachable address. Render it for the surface:

- **Control UI:** the action opens the exact setting. Verify navigation, scrolling, and highlighting.
- **Formatted channel:** link the action phrase, such as “Update the OpenAI account”.
- **Plain-text channel:** write the phrase, then the address.
- **No reachable address:** name the place in words, such as “Update the OpenAI account in Settings → Models”.

A relative route or localhost address is not a reachable external link. Use the destination contract rather than constructing URLs from configuration keys. Test all three channel forms. Keep the sentence understandable without formatting.

## Placeholders

Use display names from the owning provider or model catalog. Test long names and missing values. When a name is unknown, use the neutral product term for that meaning. Preserve exact technical identifiers only in commands, code, and diagnostic detail where needed.

## Checks

- Catalog edits follow the [i18n rules](../../../../ui/AGENTS.md#i18n-rules), including baseline updates.
- Read the text with its surrounding controls and realistic placeholder values.
- Follow the [state capture gate](../../openclaw-pr-maintainer/references/media.md#error-empty-and-loading-states) for every added or changed error, empty, or loading state.
- Copy-only punctuation changes preserve loading behavior. The capture shows what exists, not an added spinner.
