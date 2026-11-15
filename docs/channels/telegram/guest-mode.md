---
summary: "Opt-in, isolated text replies to Telegram guest requests"
title: "Telegram Guest Mode"
read_when:
  - You want to answer mentions from chats where your Telegram bot is not a member
---

# Telegram Guest Mode

Guest Mode lets an authorized Telegram user mention your bot in a chat where the
bot is not a member, including a conversation with another person. It is not
inline mode, a Control UI guest role, or bot-to-bot messaging.

**Off by default.** Enable Guest Mode for the test bot in BotFather separately,
then explicitly opt in in OpenClaw. The bot's `getMe` response must report
`supports_guest_queries: true`; that flag alone never enables OpenClaw access.

`channels.telegram.guestMode` is inherited by accounts. An account override can
set its own policy:

```json5
{
  channels: {
    telegram: {
      accounts: {
        public: {
          guestMode: {
            enabled: true,
            allowFrom: ["123456789"],
          },
        },
      },
    },
  },
  bindings: [{ agentId: "public-assistant", match: { channel: "telegram", accountId: "public" } }],
}
```

Only numeric Telegram user IDs in this account's **guest-specific** allowlist may
invoke the feature. There is no wildcard, username lookup, pairing-store grant,
or implicit grant from ordinary DM/group access. Missing senders, bot senders,
and messages sent on behalf of a chat are rejected without an agent turn or reply.
Enabling the mode with an empty allowlist admits nobody.

## Routing and privacy

Account and channel bindings select the same agent as other account traffic;
there is no hard-coded global agent. Ordinary DM/group/topic peer bindings do not
apply to an external guest chat. A guest interaction uses its own group-like
session key, separated by account, originating chat, caller, and update ID.
Even numerically identical ordinary and guest chat IDs never share a transcript.
Each new guest interaction starts without prior conversational history.

This version is deliberately **text-only and tool-free**. The selected account
agent and model are retained. The built-in OpenClaw runtime uses its isolated
model-request path: no previous conversation history, workspace bootstrap files,
bootstrap/prompt/memory-hook contributions, custom context-engine additions, or
model-callable tools enter the request. Private compaction and memory-flush
work are not run for this public turn. The explanatory public-context prompt is
not the enforcement boundary.

Strict isolation is currently qualified only for the **built-in OpenClaw runtime**.
A configured native CLI or custom harness is refused before inference; OpenClaw
does not silently change the agent, model, billing path, or runtime to make the
request succeed. Configure the public agent's model to use the built-in runtime
when testing this MVP. Tool-enabled or additional-runtime guest support is
outside this version.

## Delivery and limits

Polling and webhook use the existing single receiver and durable ingress queue.
Do not run a second poller for the same token. Guest updates are subscribed on
both transports; when disabled they are acknowledged without execution.

A request must contain text, be no more than five minutes old on arrival, and
finish within a 60-second local budget. These are OpenClaw resource bounds, not
a documented Telegram query TTL or a guarantee that a query remains valid.
Existing agent concurrency limits and the per-chat/caller Telegram lane apply.
Only the first final reply is sent, in one `answerGuestQuery` article. Text longer
than 4096 UTF-16 code units is truncated with an ellipsis without splitting a
surrogate pair. Empty or media-only final payloads get a short no-text notice.
An intentionally suppressed or cancelled turn emits no reply.

No ordinary `sendMessage` fallback, typing action, draft, reaction, callback,
media delivery, or chunked reply is used. Successful guest API responses are
`SentGuestMessage` objects, not booleans. The query capability is never placed in
the agent prompt, session key, or diagnostics. Guest API errors are reported
without their potentially sensitive payloads.

The normal update tracker and durable ingress owner handle duplicate updates and
adoption. Dispatch failures before adoption retain their original error for the
existing ingress retry classifier instead of being marked skipped. After adoption, a
crash may lose the answer but does not intentionally replay it. Delivery is one
logical answer attempt, not an exactly-once guarantee: an ambiguous network failure
can mean the answer was posted. OpenClaw does not blindly resend it. The existing
account limiter may retry a definitive Telegram 429 rejection within the turn
budget. Account authorization and routing are checked again immediately before
delivery, including after limiter waits. Stopping the bot or
aborting the turn prevents pending guest delivery. No Telegram stoppable draft is
created, so Telegram's draft Stop button is not offered.

## Test before rollout

Use a dedicated test bot, an isolated Gateway, and consenting participants. Do
not change a production bot or run competing receivers to test this feature.
Verify both an external group and a two-person private chat, authorized and
unauthorized callers, two differently bound accounts, cancellation, expiry,
duplicate delivery, restart behavior, and unchanged ordinary DM/group/topic/
channel-post traffic. Seed synthetic private-context canaries and confirm they
do not appear in guest responses. Keep query IDs and foreign chat payloads out
of screenshots, reports, and shared logs.

Automated transport tests do not replace a real Telegram round trip. Until that
round trip is completed for your bot, treat live acceptance as incomplete.
