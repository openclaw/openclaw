---
summary: "iMessage tapbacks, threaded replies, effects, native polls, approval controls, and question reactions"
read_when:
  - Using reactions, edits, effects, or polls from an agent
  - Wiring exec approvals to iMessage
  - Debugging a missing action on the message tool
title: "iMessage private API actions"
sidebarTitle: "Private API actions"
---

The action surface a probed private API bridge adds on top of plain text sends.

## Private API actions

When `imsg launch` is running and `openclaw channels status --probe` reports `privateApi.available: true`, the message tool can use iMessage-native actions in addition to normal text sends.

All actions are enabled by default; use `channels.imessage.actions` to turn individual actions off:

```json5
{
  channels: {
    imessage: {
      actions: {
        reactions: true,
        edit: true,
        unsend: true,
        reply: true,
        sendWithEffect: true,
        sendAttachment: true,
        renameGroup: true,
        setGroupIcon: true,
        addParticipant: true,
        removeParticipant: true,
        leaveGroup: true,
        polls: true,
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Available actions">
    - **react**: Add/remove iMessage tapbacks (`messageId`, `emoji`, `remove`). Supported tapbacks map to love, like, dislike, laugh, emphasize, and question. Removing without an emoji clears whichever tapback was set.
    - **reply**: Send a threaded reply to an existing message (`messageId`, `text` or `message`, plus `chatGuid`, `chatId`, `chatIdentifier`, or `to`). Local reply-with-attachment additionally needs an `imsg` build whose `send-rich` supports `--file`. With remote `imsg` v0.13.4, attachment replies use JSON-RPC and support the whole message or part index `0`; nonzero attachment part indices are not supported by the RPC method.
    - **sendWithEffect**: Send text with an iMessage effect (`text` or `message`, `effect` or `effectId`). Short names: slam, loud, gentle, invisibleink, confetti, lasers, fireworks, balloon, heart, echo, happybirthday, shootingstar, sparkles, spotlight.
    - **edit**: Edit a sent message on supported macOS/private API versions (`messageId`, `text` or `newText`). Only messages the gateway itself sent can be edited.
    - **unsend**: Retract a sent message on supported macOS/private API versions (`messageId`). Only messages the gateway itself sent can be unsent.
    - **upload-file**: Send media/files (`buffer` as base64 or a hydrated `media`/`path`/`filePath`, `filename`, optional `asVoice`). Legacy alias: `sendAttachment`.
    - **renameGroup**, **setGroupIcon**, **addParticipant**, **removeParticipant**, **leaveGroup**: Manage group chats when the current target is a group conversation. These mutate the host's Messages identity, so they require an owner sender or an `operator.admin` Gateway client.
    - **poll**: Create a native Apple Messages poll (`pollQuestion`, `pollOption` repeated 2 to 12 times, plus `chatGuid`, `chatId`, `chatIdentifier`, or `to`). Recipients on iOS/iPadOS/macOS 26+ see and vote on it natively; older OS versions get a "Sent a poll" text fallback. Requires `selectors.pollPayloadMessage`.
    - **poll-vote**: Vote on an existing poll (`pollId` or `messageId`, plus exactly one of `pollOptionIndex`, `pollOptionId`, or `pollOptionText`). Requires `selectors.pollVoteMessage` and the `poll.vote` RPC method. Remote `imsg` v0.13.4 RPC accepts only the option ID, so remote setups must use `pollOptionId`; index and text selectors remain available to local setups.

    Accepted inbound polls are rendered for the agent with the question, option labels, vote counts, and the poll message ID needed by `poll-vote`. Remote accounts also include each stable option ID and direct the agent to use `pollOptionId`.

  </Accordion>

  <Accordion title="Message IDs">
    Inbound iMessage context includes both short `MessageSid` values and full message GUIDs (`MessageSidFull`) when available. Short IDs are scoped to the recent SQLite-backed reply cache and are checked against the current chat before use. If a short ID expires, retry with its `MessageSidFull` while targeting the conversation that supplied it. Full IDs do not bypass conversation or account binding, so replace an ID from another chat with one from the current target. Remote delegated calls can reject stale full IDs when current-conversation evidence is unavailable.

  </Accordion>

  <Accordion title="Capability detection">
    OpenClaw hides private API actions only when the cached probe status says the bridge is unavailable. If the status is unknown, actions remain visible and dispatch probes lazily so the first action can succeed after `imsg launch` without a separate manual status refresh.

  </Accordion>

  <Accordion title="Read receipts and typing">
    When the private API bridge is up, accepted inbound chats are marked read and direct chats show a typing bubble as soon as the turn is accepted, while the agent prepares context and generates. Disable read-marking with:

    ```json5
    {
      channels: {
        imessage: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    Older `imsg` builds that pre-date the per-method capability list gate off typing/read silently; OpenClaw logs a one-time warning per restart so the missing receipt is attributable.

  </Accordion>

  <Accordion title="Inbound tapbacks">
    OpenClaw subscribes to iMessage tapbacks and routes accepted reactions as system events instead of normal message text, so a user tapback does not trigger an ordinary reply loop.

    Notification mode is controlled by `channels.imessage.reactionNotifications`:

    - `"own"` (default): notify only when users react to bot-authored messages.
    - `"all"`: notify for all inbound tapbacks from authorized senders.
    - `"off"`: ignore inbound tapbacks.

    Per-account overrides use `channels.imessage.accounts.<id>.reactionNotifications`.

  </Accordion>

  <Accordion title="Approval polls and reactions">
    When `approvals.exec.enabled` or `approvals.plugin.enabled` is true and the request routes natively to iMessage, the gateway delivers an approval prompt with native controls:

    - On a probed private API bridge with poll and caption-suppression support, the prompt includes a Messages poll with each allowed decision. Older `imsg` releases without `poll send --no-comment` stay on text controls.
    - If polls are disabled with `channels.imessage.actions.polls: false`, the bridge lacks poll support, the poll send fails, or fewer than two decisions are available, the prompt keeps the text and tapback controls.
    - The text fallback maps `👍` (Like) to `allow-once` and `👎` (Dislike) to `deny`. It also includes `/approve <id> <decision>` commands, including `allow-always` when the request permits it.

    Poll votes and reactions require the acting user's handle to be an explicit approver. The approver list is read from `channels.imessage.allowFrom` (or `channels.imessage.accounts.<id>.allowFrom`); add the user's phone number in E.164 form or their Apple ID email (chat targets such as `chat_id:*` are not valid approver entries). The wildcard entry `"*"` is honored but allows any sender to approve; an empty approver list disables poll and reaction shortcuts entirely. These shortcuts intentionally bypass `reactionNotifications`, `dmPolicy`, and `groupAllowFrom` because the explicit-approver allowlist is the only gate that matters for approval resolution.

    Native poll controls are currently limited to channel-native delivery in the originating iMessage session or an iMessage approver DM. Explicit forwarding targets selected by `approvals.exec.mode: "targets"` (and the target half of `"both"`) continue to use the existing forwarded approval message instead of an iMessage poll.

    `/approve` text command authorization follows the same list: when `channels.imessage.allowFrom` is non-empty, `/approve <id> <decision>` is authorized against that approver list (not the broader DM allowlist), and senders permitted on the DM allowlist but not in `allowFrom` receive an explicit denial. When `allowFrom` is empty, the same-chat fallback stays in effect and `/approve` authorizes anyone the DM allowlist permits. Add every operator who should approve — via `/approve` or via reactions — to `allowFrom`.

    Operator notes:
    - Poll and reaction bindings are stored both in memory and in the gateway's persistent keyed store (TTL matched to the approval expiry), and the gateway also polls pending prompts for tapbacks. After a gateway restart, a tap on an old control is recognized and swallowed instead of entering agent chat, but the restart ends the in-flight command; request a new approval rather than expecting the old control to resume it.
    - The operator's own `is_from_me=true` tapback (for example from a paired Apple device) resolves the approval when that handle is an explicit approver.
    - Approval prompts route into a group conversation only when explicit approvers are configured; otherwise any group member could approve.
    - Legacy text-style tapbacks (`Liked "…"` plain text from very old Apple clients) cannot resolve approvals because they carry no message GUID; reaction resolution requires the structured tapback metadata that current macOS / iOS clients emit.

  </Accordion>

  <Accordion title="Question reactions (1️⃣ / 2️⃣ / 3️⃣ / 4️⃣)">
    For an `ask_user` prompt with one non-secret, single-select question and one to four options, OpenClaw adds numbered emoji choices. React to the delivered prompt with the matching number to answer it. The reaction must carry the stable GUID of the bot-authored message; OpenClaw then maps the number to the canonical option through the Gateway. Stale or duplicate taps are ignored.

    Multi-question, multi-select, and free-text prompts remain text-reply-only. Question reactions follow normal iMessage DM/group admission rules. They are recognized even when general `reactionNotifications` is `"off"`, without turning unrelated reactions into agent events.

  </Accordion>
</AccordionGroup>
