# Error messages

Use for failures anywhere a reader sees them, including a tool result an agent reports, a server error, a slash command reply, or a CLI message.

## Start with the cause

1. Read what the producer knows and how the message reaches the reader. Give each detectable cause its own short plain sentence. Use the generic sentence only when the cause is unknown: “OpenClaw couldn’t finish this reply.”
2. For run failures, select the cause in `src/shared/failure-causes.ts` and use its typed facts and recovery choices. Keep the sentence at that owner. If the checkout predates the shared cause list, reconcile the owning errors change before implementation rather than creating a competing list in a caller.
3. Resolve provider and model display names through their owners. The templates are “{provider} is rate limiting {model} until {time}.” and “{provider} reported a billing problem with the account OpenClaw uses.” Include a time only when it is known.
4. Tell the reader what happened to their work when the code knows: saved, unchanged, not sent, or still running. An uncertain result stays uncertain. Distinguish uncertainty about completion from a known cause. Neither proves that nothing happened.

**Done:** every sentence is supported by classified facts, and each genuinely distinct known cause is represented.

## Choose a useful next step

- Offer “Try again” only when retrying can work. Respect a known wait time. A retry never implies an automatic resend.
- Prefer the step most likely to work. Offer at most one action in the chat and one settings link, joined with “or” when they are alternatives.
- A reader's deliberate cancellation, declined permission, or choice of another path is a state, not a failure. Say what stopped and what remains.
- Use the actual access level the operation requires. Read access is not admin access. The non-admin role formerly labeled Operator is Teammate, not admin. A session owner assignment grants no new access.

Recovery belongs to the surface. A supported slash command such as /model or /new is something the person can send in that chat. A shell command is not an inline recovery step in a channel notice.

## Link to the fix

| Where the fix is                                                            | What to add                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| In an OpenClaw setting                                                      | Link the action phrase to the exact setting.          |
| In OpenClaw, but outside the Control UI, such as paired-device or CLI setup | Link to an existing docs section explaining that fix. |
| On the provider's side, or neither of those                                 | The sentence alone.                                   |

A provider-side cause may also have a usable OpenClaw alternative, such as switching models or configuring a fallback. Add that only when available to this reader. Billing does not warrant a guessed provider billing URL.

Render settings destinations using the three forms in [product text](product-text.md#settings-and-recovery-links): a linked phrase, a phrase followed by an address, or the place in words when no reachable address exists. Verify the actual destination. A link to the wrong page is not a recovery step.

## Two tiers of detail

The page or message shows the plain sentence. Put diagnostic evidence in nested **Show details** content only when there is more useful information to show. A technical code belongs there only when it changes what the reader does. Keep raw provider bodies, exceptions, tool names, and exit codes out of the headline sentence.

A plain-text channel gets the useful sentence and available action. It need not reproduce an expandable UI. Do not send people to logs as the default next step. Diagnostic details must follow the repository's redaction and disclosure rules.

## Calm, direct words

Make the failed thing or OpenClaw the subject. State known facts directly. Keep apologies, “oops”, jokes, blame, alarm words, and hedging out of the sentence. Replace labels such as “invalid”, “illegal”, “forbidden”, “fatal”, “aborted”, and “you forgot” with the concrete problem or required access. Keep punctuation level and follow [sentence rules](sentences.md).

## Verify

- Exercise the known cause and the unknown-cause path at the producing boundary. Confirm names, timing, access, and recovery availability.
- Check the status of the reader's work. Do not invent a blanket “check everything before retrying” caution. The policy for additional uncertain-work cautions is still being decided separately.
- Capture the added or changed state through the real product under the [state capture gate](../../openclaw-pr-maintainer/references/media.md#error-empty-and-loading-states). Real channel notices need each link form captured.
