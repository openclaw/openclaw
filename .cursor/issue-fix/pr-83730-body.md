## Summary

**What problem does this PR solve?**

Non-thread Feishu p2p (DM) replies are routed to `chat:<oc_xxx>` (the raw p2p chat ID) instead of `user:<open_id>`, causing `SUBSCRIPTION_NOT_FOUND` errors when the bot attempts to reply.

**Why does this matter now?**

Issue #83730 is a P1 regression introduced in OpenClaw 2026.5.12. After `skipReplyToInMessages` suppresses reply metadata for non-thread DMs, the visible reply becomes a top-level send to the `oc_*` chat target — which Feishu rejects.

**What is the intended outcome?**

- Non-thread p2p DM replies are sent to `user:<open_id>` instead of `chat:<oc_xxx>`
- Thread p2p DM replies and group replies are unaffected
- Streaming start, typing indicators, and conversation type detection keep using `chatId` as before

**What is intentionally out of scope?**

- No changes to other channels or the Feishu send/target resolution layer
- No changes to `send-target.ts`, `targets.ts`, or `send.ts`

**What does success look like?**

`sendMessageFeishu`, `sendMediaFeishu`, and `sendStructuredCardFeishu` receive `user:ou_*` as the `to:` target for non-thread p2p replies instead of `oc_*`.

## Linked context

Closes #83730

Related clawtributors: #83764 (closed unmerged), #90636 (closed unmerged), #94761 (sibling PR, different approach)

## Real behavior proof (required for external PRs)

- **Behavior or issue addressed:** Non-thread Feishu p2p DM replies use `user:<open_id>` target instead of raw `chatId`
- **Real environment tested:** Local checkout of openclaw fix branch (commit 8b01486c) + live Feishu bot connected via WebSocket (appId cli_a9f668faaab89bd1)
- **Exact steps or command run after this patch:**
  ```
  # Build OpenClaw from fix branch
  # Start gateway with Feishu channel
  OPENCLAW_CONFIG_PATH=~/feishu-test/openclaw.json \
    OPENCLAW_STATE_DIR=~/feishu-test/data \
    pnpm openclaw gateway run --allow-unconfigured --auth none
  # Send DM to bot via Feishu app
  ```
- **Evidence after fix:**

  ```
  # Gateway logs from live Feishu p2p DM test (user IDs redacted)

  2026-06-19T16:30:42.334 [feishu] received message from ou_REDACTED in oc_REDACTED (p2p)
  2026-06-19T16:30:42.343 [feishu] Feishu[default] DM from ou_REDACTED: 你好你好你好
  2026-06-19T16:30:42.348 [feishu] dispatching to agent (session=agent:main:main)
  2026-06-19T16:30:59.555 [feishu] dispatch complete (queuedFinal=true, replies=1)

  2026-06-19T16:31:11.217 [feishu] received message from ou_REDACTED in oc_REDACTED (p2p)
  2026-06-19T16:31:11.222 [feishu] Feishu[default] DM from ou_REDACTED: 你是哪里人？
  2026-06-19T16:31:11.225 [feishu] dispatching to agent (session=agent:main:main)
  2026-06-19T16:31:21.116 [feishu] dispatch complete (queuedFinal=true, replies=1)
  ```

  ![Feishu chat screenshot](https://github.com/user-attachments/assets/ddcf293d-2945-44df-832c-83f1d0472a2a)

- **Observed result after fix:** The AI replied to both DMs successfully. The chat screenshot shows the bot replying. No `SUBSCRIPTION_NOT_FOUND` errors in any log line.
- **What was not tested:** Group chat replies and thread DM replies (same code path, expected unaffected). Streaming cards fall back to non-streaming delivery due to a pre-existing card creation HTTP 400 (unrelated to this dispatch target fix).
- **Proof limitations:** The bot Feishu app lacks `contact:contact.base:readonly` scope (stale, non-blocking). Streaming card creation returns HTTP 400 for a pre-existing permission reason, so streaming cards fall back to non-streaming card delivery. The fix does not address this unrelated card creation issue.
- **Before evidence (optional):** On current main, `createFeishuReplyDispatcher` constructs all visible sends with `to: chatId` (the `oc_*` p2p chat ID), which Feishu rejects with `SUBSCRIPTION_NOT_FOUND` for non-thread DM replies.

## Tests and validation

- `CI=true node node_modules/.bin/vitest run extensions/feishu/src/reply-dispatcher.test.ts` — 82 passed
- `CI=true node node_modules/.bin/vitest run extensions/feishu/src/bot.test.ts` — 87 passed
- `CI=true node node_modules/.bin/vitest run extensions/feishu/src/channel.test.ts extension/feishu/src/send.test.ts extension/feishu/src/send-target.test.ts` — 84 passed
- All 253 tests green

**Regression coverage:** All existing Feishu reply-dispatcher and bot tests continue to pass. The fix is applied at the dispatcher parameter level. Streaming card delivery now also routes through `effectiveSendTarget` with suppressed reply metadata and normalized receive ID prefix.

## Risk checklist

**Did user-visible behavior change?** (`Yes`)

Yes — non-thread Feishu p2p DM replies now go to `user:<open_id>` instead of `chat:<oc_xxx>`, fixing the SUBSCRIPTION_NOT_FOUND error.

**Did config, environment, or migration behavior change?** (`No`)

**Did security, auth, secrets, network, or tool execution behavior change?** (`No`)

**What is the highest-risk area?** The `to:` target change affects all visible sends (text, card, media, no-visible-reply fallback). Streaming start and conversation type detection are unchanged.

**How is that risk mitigated?** The `sendTarget` parameter defaults to `undefined`, falling back to `chatId`. Both dispatcher call sites in `bot.ts` pass the pre-computed `feishuTo` value. Live Feishu p2p DM test confirms two successful dispatches.

## Current review state

**What is the next action?**

Maintainer / ClawSweeper review

**What is still waiting on author, maintainer, CI, or external proof?**

ClawSweeper re-review verdict. CI checks. Live Feishu p2p DM evidence (logs + screenshot) included above.
