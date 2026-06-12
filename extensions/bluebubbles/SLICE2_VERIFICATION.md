# Slice 2 Verification Packet

Date: 2026-06-12

Scope: BlueBubbles/Text Mailroom foundation only.

Code commit:

- `1c7981c3f8b1c21ccdb4d56ef7f3e3e80e375aae` - `Slice 2: Text Mailroom foundation`
- Parent: `8ec0ad0a52e4449a1e09ced5c39fd7938ef680d8`
- Packet commit: this evidence file is committed separately after the code commit and reported in the final handback.

## Plain-English Result

BlueBubbles can still receive and queue supervised text messages, but all BlueBubbles outbound paths are locked behind an unset-by-default environment flag. If the flag is missing, send-like operations throw before making HTTP requests.

Supervised personal-text handling now fails closed: if an account is marked as supervised but supervision is disabled or invalid, inbound DMs are dropped with metadata-only logs before pairing, auto-replies, or agent dispatch can happen.

The new Text Mailroom client is read-only with respect to the inbound queue: it can show safe previews, draft locally, classify locally, hold, close, digest, and report health. It has no send verb and imports no send-capable modules.

## Phase Summary

P0 - Skill documentation:

- Replaced `/Users/chrisreyes/.codex/skills/sms-supervisor/SKILL.md` with read-only Text Mailroom instructions.
- Backup saved at `/Users/chrisreyes/.codex/skills/sms-supervisor/SKILL.md.slice2.bak`.
- Removed the prior instruction that said: `For send sms N, confirm the stored draft and send only if Chris explicitly asked to send.`
- Grep check for send/broadcast/reply-style instructions in the new skill returned no matches.
- This file is outside the repository and is intentionally not part of the repo commit.

P1 - Outbound gate:

- `extensions/bluebubbles/src/types.ts:109` defines `OPENCLAW_BLUEBUBBLES_OUTBOUND_ENABLED`.
- `extensions/bluebubbles/src/types.ts:147` fails closed unless the variable is exactly `1`.
- `extensions/bluebubbles/src/types.ts:155` wraps outbound fetches with the gate.
- Public send surfaces were guarded in `send.ts`, `attachments.ts`, `media-send.ts`, `reactions.ts`, `chat.ts`, and `channel.ts`.

P2 - Supervised reply safety:

- `extensions/bluebubbles/src/supervised.ts:136` treats an own `supervisedReplies` account property as intended-supervised.
- `extensions/bluebubbles/src/supervised.ts:235` resolves supervision only from enabled inline account config; the old workspace fallback is gone.
- `extensions/bluebubbles/src/monitor-processing.ts:184` intercepts intended-supervised DMs before pairing/agent dispatch.
- `extensions/bluebubbles/src/monitor-processing.ts:187` drops disabled/null supervision with sender/body hashes and lengths only.
- `extensions/bluebubbles/src/monitor-processing.ts:954` drops supervised reactions before agent dispatch, with metadata-only logging.
- `extensions/bluebubbles/src/monitor.ts:494` refuses to start a supervised account if supervision is disabled.
- `extensions/bluebubbles/src/monitor.ts:501` refuses `dmPolicy=pairing` for supervised accounts.

P3 - Mailroom foundation:

- `extensions/bluebubbles/src/mailroom.ts:5` registers only `show`, `draft`, `hold`, `close`, `classify`, `digest`, and `health`.
- `extensions/bluebubbles/src/mailroom.ts:37` reserves send-audit event names but does not expose a send verb.
- `extensions/bluebubbles/src/mailroom.ts:210` calls draft hooks with `tools: []`.
- `extensions/bluebubbles/src/mailroom.ts:252` calls classify hooks only after allowlist gating and with `tools: []`.
- `extensions/bluebubbles/src/mailroom.ts:280` reads `latest.json` and `threads/*.json`.
- `extensions/bluebubbles/src/mailroom.ts:368` returns escaped safe previews instead of raw thread bodies.
- `extensions/bluebubbles/src/mailroom.ts:382` uses metadata-only digest items.
- `extensions/bluebubbles/src/mailroom.ts:421` writes annotations only under `annotations/`.
- `extensions/bluebubbles/src/mailroom.ts:442` appends metadata-only audit events under `audit/`.
- `extensions/bluebubbles/src/mailroom.ts:464` enforces private directory modes.

P4 - Tests and verification:

- Baseline before edits: 248/248 extension tests passed.
- Final after edits: 263/263 extension tests passed.
- Net new tests: 15.
- No skipped tests in either baseline or final run.

## Exact Test Command

```sh
./node_modules/.bin/vitest run extensions/bluebubbles/src/
```

Final output summary:

```text
Test Files  10 passed (10)
     Tests  263 passed (263)
  Duration  25.34s
```

Expected stderr during the run was limited to existing webhook rejection tests for invalid JSON, timeout, unauthorized requests, and ambiguous routing.

## New Safety Tests

- `outbound_gate_throws_when_flag_unset`
- `supervised_valid_resolution_enqueues_for_review`
- `supervised_null_resolution_drops_dm_and_does_not_dispatch_agent`
- `audit_and_logs_never_contain_message_body`
- `pairing_auto_reply_skipped_for_supervised_account`
- `start_refuses_supervised_account_when_disabled_or_pairing`
- `processReaction_for_supervised_account_enqueues_no_agent_visible_body`
- `no_outbound_verb_is_registered`
- `mailroom_module_imports_no_send_code`
- `show_returns_escaped_previews_and_never_raw_thread_body_fields`
- `unknown_sender_digest_contains_no_body_bytes`
- `llm_steps_expose_no_tools`
- `classify_does_not_call_llm_for_non_allowlisted_sender`
- `audit_and_annotation_stores_are_private_and_do_not_rewrite_queue_files`
- `health_reports_permissions_and_freshness_without_autofix`

## Test-to-Property Map

- Outbound disabled by default: `outbound_gate_throws_when_flag_unset`.
- No HTTP happens when disabled: the same outbound-gate test stubs `fetch` and asserts zero calls.
- Supervised DMs queue only when enabled inline config exists: `supervised_valid_resolution_enqueues_for_review`.
- Disabled/missing supervision never reaches the agent: `supervised_null_resolution_drops_dm_and_does_not_dispatch_agent`.
- Message bodies stay out of logs/audit for disabled supervision: `audit_and_logs_never_contain_message_body`.
- Pairing auto-reply is bypassed for supervised accounts: `pairing_auto_reply_skipped_for_supervised_account`.
- Supervised accounts cannot start in unsafe disabled/pairing states: `start_refuses_supervised_account_when_disabled_or_pairing`.
- Supervised reactions do not create agent-visible events: `processReaction_for_supervised_account_enqueues_no_agent_visible_body`.
- Mailroom has no outbound command: `no_outbound_verb_is_registered`.
- Mailroom imports no send-capable modules: `mailroom_module_imports_no_send_code`.
- Mailroom show/digest avoid raw thread body exposure: `show_returns_escaped_previews_and_never_raw_thread_body_fields`, `unknown_sender_digest_contains_no_body_bytes`.
- LLM hooks receive no tools: `llm_steps_expose_no_tools`.
- Classification is allowlist-gated: `classify_does_not_call_llm_for_non_allowlisted_sender`.
- Mailroom writes only private annotation/audit stores: `audit_and_annotation_stores_are_private_and_do_not_rewrite_queue_files`.
- Health reports status without auto-fixing permissions: `health_reports_permissions_and_freshness_without_autofix`.

## Outbound Surface Inventory

Guarded send-like paths:

- `extensions/bluebubbles/src/send.ts:331`, `342`, `404`, `465`
- `extensions/bluebubbles/src/attachments.ts:210`, `280`
- `extensions/bluebubbles/src/media-send.ts:223`
- `extensions/bluebubbles/src/reactions.ts:174`, `186`
- `extensions/bluebubbles/src/chat.ts:56`, `62`, `82`, `88`, `118`, `131`, `161`, `172`, `202`, `209`, `243`, `250`, `284`, `291`, `322`, `329`, `356`, `394`
- `extensions/bluebubbles/src/channel.ts:294`, `314`, `328`

Read/probe paths intentionally remain readable:

- `extensions/bluebubbles/src/probe.ts:51`, `53`, `142`, `144`
- `extensions/bluebubbles/src/send.ts:206`, `209` for chat lookup only
- `extensions/bluebubbles/src/attachments.ts:84`, `87` for inbound attachment download only

## Still Disabled Proof

Runtime/config checks were redacted before recording. Raw config values and tokens were not copied into this packet.

Redacted config summary:

```json
{
  "channelKeys": ["slack", "telegram"],
  "hasChannelsBluebubbles": false,
  "pluginEntries": ["codex", "openai", "slack", "telegram"],
  "hasPluginBluebubbles": false
}
{"smsSupervisorEnabled": false}
```

File hash/stat proof showed these files unchanged from the pre-edit snapshot:

```text
ee93f730... /Users/chrisreyes/.openclaw/openclaw.json
c6522c33... /Users/chrisreyes/.openclaw/workspace/sms-supervisor/config.json
0acc80db... /Users/chrisreyes/.openclaw/credentials/bluebubbles-pairing.json
538976c5... /Users/chrisreyes/.openclaw/credentials/bluebubbles-default-allowFrom.json

/Users/chrisreyes/.openclaw/openclaw.json 100600 10668 1780701632
/Users/chrisreyes/.openclaw/workspace/sms-supervisor/config.json 100644 91 1776525512
/Users/chrisreyes/.openclaw/credentials/bluebubbles-pairing.json 100600 37 1776479717
/Users/chrisreyes/.openclaw/credentials/bluebubbles-default-allowFrom.json 100600 100 1776524582
```

Runtime check:

- No local `BlueBubbles` process was running.
- No BlueBubbles container was running.
- Existing OpenClaw gateway container was still on the prior image and was not restarted by this work.

## Working Tree Hygiene

- Pre-existing unrelated dirty files were preserved.
- A filtered before/after status comparison excluding `extensions/bluebubbles/` had no diff.
- The code commit touches only `extensions/bluebubbles/src/*` files.
- This packet touches only `extensions/bluebubbles/SLICE2_VERIFICATION.md`.

## Deviations and Caveats

- The implementation uses one code commit plus one packet-only commit, not one commit per phase. P1, P2, and P4 share modified test files, so reconstructing phase commits after verification would have been artificial.
- Some existing positive outbound tests were rewritten to assert the new disabled-by-default contract while preserving their test names.
- The mailroom `health` verb writes a metadata-only audit event; it reports permission/freshness state and does not auto-fix queue files.
- The live service was not enabled, restarted for BlueBubbles, or pointed at BlueBubbles as part of this slice.
