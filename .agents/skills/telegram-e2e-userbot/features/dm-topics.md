# DM topics

Use this recipe when the claim concerns topics in the leased SUT bot's direct
chat, rather than topics in a group forum. Complete the exact-ref and credential
readiness in [`SKILL.md`](../SKILL.md) first.

During the lease, the QA user owns the SUT bot. `--create-dm-topic` uses that
user's existing TDLib driver to open BotFather's Test Server Mini App, enables
**Threaded Mode** through Playwright, and creates a native DM forum topic. Every
scenario send targets that topic. Cleanup deletes the run-owned topic and
switches Threaded Mode off before releasing the credential.

Prepare Playwright's Chromium before leasing. Set an explicit browser cache and
keep the variable for the runner, whose TDLib driver has an isolated `HOME`:

```bash
export PLAYWRIGHT_BROWSERS_PATH=0
pnpm exec playwright install chromium
```

The signed Mini App URL stays in a temporary `0600` file in private driver
state, is never printed, and is removed after the browser action. The helper
captures no page text, images, or traces because BotFather can display the bot token.

## Drive

Write a scenario in the durable proof directory:

```json
{
  "actions": [
    {
      "type": "send",
      "text": "Please answer with OPENCLAW_E2E_OK only.",
      "awaitReply": { "text": "OPENCLAW_E2E_OK" }
    }
  ]
}
```

```bash
node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
  --gateway-port "$TELEGRAM_GATEWAY_PORT" --mock-port "$TELEGRAM_MOCK_PORT" \
  --dm --create-dm-topic --scenario "$TELEGRAM_E2E_PROOF_DIR/scenario.json" \
  --record "$TELEGRAM_E2E_PROOF_DIR/events.ndjson" \
  --output "$TELEGRAM_E2E_PROOF_DIR/summary.json"
```

Let the runner supply `forumTopicId`; do not hard-code another lease's topic.

## Judge and restore

Require `summary.json` to show `testDmTopic.setup.threadedMode.after: true`, a
positive `forumTopicId`, and a later SUT reply carrying that same native topic
identity. Correlate the sent action and reply using the marker, and require the
matching provider request. A reply in the ordinary DM does not prove topic routing.

Require `testDmTopic.cleanup.status: restored` and
`testDmTopic.cleanup.threadedMode.after: false`. BotFather's server-side setting
and native topic creation are authoritative: Test Bot API `getMe.has_topics_enabled`
can lag, so it is not a readiness or cleanup gate. A failed cleanup retains the
credential rather than releasing authority whose restoration is unconfirmed.
