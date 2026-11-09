# Telegram restart attribution

Use the canonical runner with distinct, run-specific before/after markers. A
timed restart alone cannot distinguish a recovered baseline delivery from a fresh
post-restart reply. This recipe proves a new turn after process replacement;
it does not inject accepted-response loss or prove durable replay recovery.

Complete [preparation](../SKILL.md#1-prepare), including explicit unused ports and
a private proof directory. Generate the scenario without credentials:

```bash
node --input-type=module - "$TELEGRAM_E2E_PROOF_DIR/restart.json" <<'JS'
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
const run = randomUUID().replaceAll("-", "").toUpperCase();
const send = (phase) => {
  const marker = `OPENCLAW_E2E_RESTART_${run}_${phase}`;
  return {
    type: "send",
    text: `Reply with exactly: ${marker}`,
    awaitReply: { text: marker, requireQuote: true },
  };
};
writeFileSync(process.argv[2], JSON.stringify({ actions: [
  send("BEFORE"), { type: "restartGateway" }, send("AFTER"),
] }, null, 2), { mode: 0o600 });
JS

E2E_TELEGRAM_CONFIG_PATCH='{"replyToMode":"all","streaming":"off"}' \
node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
  --backend mock --dm \
  --gateway-port "$TELEGRAM_GATEWAY_PORT" --mock-port "$TELEGRAM_MOCK_PORT" \
  --scenario "$TELEGRAM_E2E_PROOF_DIR/restart.json" --timeout-ms 120000 \
  --record "$TELEGRAM_E2E_PROOF_DIR/events.ndjson" \
  --output "$TELEGRAM_E2E_PROOF_DIR/summary.json"
```

The maintained mock provider recognizes each `OPENCLAW_E2E_*` input marker. Do
not replace the two prompts with one fixed response marker. The recording budget
is selected before the run and includes both turns and replacement readiness.

`send.awaitReply` blocks later recorder and Gateway actions until an exact text
revision from the selected SUT is observed after the native send. It binds the
send and reply IDs in the same observer's chat, rejects message IDs seen before
the send, and requires the same native topic. A present quote must reference the
triggering send in this chat. `requireQuote: true` additionally rejects unquoted
replies; omit it for a DM proof that intentionally permits unquoted replies.
Expected reply text must be distinct for every awaited send in the scenario.

For topic proof, select the leased forum with `--chat`, mention `@{sut}` in each
prompt, and put its actual `forumTopicId` on both sends. Keep the same barrier
sequence. The normal [forum setup and cleanup](runtime-reference.md#persistent-fixtures-and-topics)
rules apply.

Judge the private summary and native recording together:

- Both `send` actions and both `awaitReply` actions completed. Each reply receipt
  includes `actionIndex`, `sentMessageId`, its own native `messageId`, quote and
  topic fields. The two sends and two replies have distinct native identities.
- `scenario.gatewayActions` records a completed restart between those pairs.
  The baseline receipt precedes the stop; the after-send follows replacement
  readiness. A late baseline message or edit cannot satisfy the after barrier.
- Each marker reached the provider, and no extra native message carrying either
  marker appeared in the full recording. Count native identities, not revisions
  of one message. A successful recorder exit alone is not product proof.

A missing match or an unexecuted awaited send fails at the original recording
deadline and prevents later mutations. Preserve that failure; do not reinterpret
a late baseline as an after reply or retry an uncertain send. Report harness,
product, transport and infrastructure evidence separately. Export only sanitized
labels and identity relationships; retain raw native IDs in private evidence.
