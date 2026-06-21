# Gmail Ingestion Audit

## Executive decision

Recommendation:
SCRAPPED AND REBUILT WITH CODEX

Confidence:
High

One-paragraph rationale:
The current Gmail ingestion surface contains useful fragments, but it is not a structurally sound foundation for the desired Media Intelligence connector. There are two different Gmail paths: OpenClaw core Gmail Pub/Sub hooks that turn emails into agent runs, and workspace scripts that fetch Gmail messages into local JSONL/body-text artifacts. The workspace scripts are closer to read-only ingestion, but they are ad hoc, live-credential-dependent, not fixture-tested, not schema-first, weakly checkpointed, and partially mix ingestion with filtering, ranking, LLM extraction, digest/snapshot generation, and downstream local archives. The OpenClaw core hook path is explicitly agent-orchestration-centric and is the opposite of the desired "Gmail as a source, not an agent workspace" model. The safest path is to rebuild a deterministic Gmail ingestion sidecar and mine only the reusable read-only OAuth, listing, parsing, attachment-metadata, account-verification, and local JSONL/report-writing fragments.

## Current module location

Relevant repository files inspected:

- `src/hooks/gmail.ts`
- `src/hooks/gmail-watcher.ts`
- `src/hooks/gmail-watcher-lifecycle.ts`
- `src/hooks/gmail-setup-utils.ts`
- `src/hooks/gmail-ops.ts`
- `src/hooks/gmail.test.ts`
- `src/hooks/gmail-watcher-lifecycle.test.ts`
- `src/hooks/gmail-setup-utils.test.ts`
- `src/config/types.hooks.ts`
- `src/gateway/hooks.ts`
- `src/gateway/hooks-mapping.ts`
- `src/gateway/server-http.ts`
- `src/gateway/server/hooks.ts`
- `src/security/external-content.ts`
- `src/cron/isolated-agent/run.ts`
- `docs/automation/gmail-pubsub.md`
- `docs/zh-CN/automation/gmail-pubsub.md` was discovered but not treated as source because `docs/zh-CN/**` is generated.

Relevant OpenClaw workspace files inspected or identified:

- `<workspace>/scripts/ingest_main_gmail_label.py`
- `<workspace>/scripts/gmail_ingest_profile_dry_run.py`
- `<workspace>/scripts/run_main_gmail_daily_ingest.sh`
- `<workspace>/scripts/authorize_main_gmail_readonly.py`
- `<workspace>/scripts/check_creator_gmail_token_health.py`
- `<workspace>/scripts/fetch_creator_emails.py`
- `<workspace>/scripts/audit_creator_email_ingestion_coverage.py`
- `<workspace>/scripts/run_creator_email_ingest.sh` was identified as part of the creator-email workflow through static acceptance references, but not required for code-level conclusions.
- `<workspace>/scripts/backfill_creator_email_source_registry.py` was identified as a downstream source-registry handoff helper.
- `<workspace>/scripts/generate_creator_signals_digest.py` was identified as downstream interpretation/digest logic.
- `<workspace>/scripts/import_creator_signals_to_investing.py` was identified as downstream handoff/import logic.
- `<workspace>/scripts/render_creator_signals_snapshot.py` was identified as downstream snapshot logic.
- `<workspace>/configs/gmail/main-ingest-profile.json`
- `<workspace>/docs/main-gmail-daily-ingest.md`
- `<workspace>/memory/projects/gmail-patreon-substack-ingestion.md` was identified as project context, not implementation.
- `<workspace>/tests/test_scheduler_creator_email_static_acceptance.py`
- `<workspace>/reports/media_intelligence_triage/gmail_media_ingestion_pipeline_audit_latest.md`
- `<workspace>/reports/media_intelligence_triage/gmail_media_ingestion_pipeline_audit_2026-06-07.md`
- `<workspace>/reports/media_intelligence_triage/gmail_metadata_intake_queue*.jsonl|md` historical prototype artifacts.
- `<workspace>/data/creator_signals/creator_email_items.jsonl` and `<workspace>/data/creator_signals/body_text/` are current local output surfaces, not code.
- `<workspace>/data/source_registry/sources.jsonl` is a downstream handoff target, not a safe connector boundary.

Credential-bearing paths identified but not read:

- `<workspace>/scripts/token.json` exists, mode `0600`, size 744 bytes.
- `<workspace>/scripts/credentials.json` exists, mode `0600`, size 418 bytes.
- `<workspace>/credentials/gmail_intake/notemused_readonly_ideabrowser/google_token.json` exists, mode `0600`, size 799 bytes.
- `<workspace>/credentials/gmail_intake/oauth_clients/openclaw_gmail_desktop_client.json` exists, mode `0600`, size 466 bytes.

No credential file contents, token values, client secrets, private email bodies, or live Gmail message payloads were read or exposed during this audit.

## Current architecture summary

There is no single clean Gmail ingestion module. The current implementation is split across two architectures:

1. **OpenClaw core Gmail hook path**: `src/hooks/gmail*.ts`, gateway hook mapping, and cron isolated-agent dispatch. This path configures `gog gmail watch start` and `gog gmail watch serve`, receives Gmail Pub/Sub push events through a hook URL, renders a text prompt from message fields, and dispatches an isolated agent run. It is part of generic OpenClaw hook/gateway/cron orchestration, not a sidecar ingestion connector.
2. **Workspace Gmail ingestion scripts**: Python scripts under `<workspace>/scripts/` use Gmail readonly OAuth to list/query labels, fetch messages, parse body text, write local JSONL/body-text/report artifacts, maintain processed IDs, and in the creator-email flow optionally classify/rank/summarise emails through local or LLM logic. This path is closer to ingestion but is still script-specific, account-specific, and not a schema-driven sidecar.

The current design is operationally useful but architecturally mixed. Gmail-specific behavior lives in OpenClaw core hook startup/config code, workspace scripts, LaunchAgent wrappers, reports, source registry handoffs, and digest/import consumers. It can be disabled in pieces, but no single connector interface separates Gmail access from parsing, staging, interpretation, and Media Intelligence handoff.

## Current data flow

Core hook flow:

```text
Gmail watch -> Google Pub/Sub -> gog gmail watch serve -> OpenClaw /hooks/gmail -> hook mapping template -> isolated cron agent run -> optional delivery/system event
```

Main Gmail label ingest flow:

```text
LaunchAgent -> scripts/run_main_gmail_daily_ingest.sh -> scripts/ingest_main_gmail_label.py -> Gmail labels.list/profile/messages.list/messages.get -> local body_text + messages_metadata.jsonl + manifest/report JSON/MD
```

Creator-email flow:

```text
LaunchAgent/wrapper -> scripts/fetch_creator_emails.py -> Gmail messages.list/messages.get -> local body text + creator_email_items.jsonl + processed_ids.json + skip log -> creator signal snapshot/digest/import/source registry consumers
```

Desired future sidecar flow should instead be:

```text
Gmail -> deterministic read-only connector -> GmailMediaItem JSONL staging -> checkpoint/dedupe store -> Media Intelligence adapter behind feature flag
```

The current implementation does not provide that clean flow.

## Gmail access model

The code uses three access approaches:

- `gog` CLI in the core hook path:
  - `gog gmail watch start --account ... --label ... --topic ...`
  - `gog gmail watch serve --account ... --include-body --max-bytes ... --hook-url ...`
  - Pub/Sub infrastructure is created/updated through `gcloud` and Tailscale in setup utilities.
- Python Google API client in workspace scripts:
  - `google.oauth2.credentials.Credentials`
  - `googleapiclient.discovery.build("gmail", "v1", ...)`
  - `users().getProfile`, `users().labels().list`, `users().messages().list`, `users().messages().get`.
- Direct HTTPS calls to Gmail API in `ingest_main_gmail_label.py`:
  - `GET /users/{user}/labels`
  - `GET /users/{user}/profile`
  - `GET /users/{user}/messages`
  - `GET /users/{user}/messages/{id}?format=full`.

Read-only posture is mixed but mostly positive in the workspace scripts:

- Main Gmail profile explicitly requires `https://www.googleapis.com/auth/gmail.readonly`.
- `authorize_main_gmail_readonly.py` refuses non-readonly Gmail scopes.
- `ingest_main_gmail_label.py` refuses profiles where `mutate_mailbox` is not `false`.
- `fetch_creator_emails.py` uses `gmail.readonly`, but it also performs downstream local archive/snapshot writes and optional LLM extraction.

Write/delete/modify capabilities:

- The inspected Gmail API calls in workspace scripts are read-only calls; no `messages.send`, `messages.modify`, `messages.trash`, `messages.delete`, `drafts`, or `batchModify` code path was found in the inspected Gmail ingestion scripts.
- OpenClaw docs include `gog gmail send` only as a manual test command in `docs/automation/gmail-pubsub.md`. That is not part of the ingestion code path, but it is an unsafe operational footgun for a read-only ingestion module.
- Setup code mutates local config, Pub/Sub topics/subscriptions/IAM, Tailscale serve/funnel state, and local OAuth token files. Those are not mailbox mutations, but they are production/environment mutations and therefore unsuitable for a pure ingestion connector runtime.

Credential handling:

- Credential files are local and mode `0600` on inspected paths.
- The main profile uses a `credentials/gmail_intake/...` token path; creator flow still keeps `token.json` and `credentials.json` under `<workspace>/scripts/`, which is brittle and looks like executable-source-adjacent secret placement.
- The code includes some secret-scrubbing/error-scrubbing functions and avoids printing token contents.
- The audit found credential-bearing files by path but did not read them.

## State and checkpointing

Current state handling is insufficient for a production Media Intelligence connector.

Observed state:

- `fetch_creator_emails.py` stores processed Gmail IDs in `<workspace>/inbox/processed_ids.json`.
- `fetch_creator_emails.py` dedupes archive appends by `gmail_message_id` against `<workspace>/data/creator_signals/creator_email_items.jsonl`.
- `ingest_main_gmail_label.py` writes timestamped run directories and report manifests, but does not maintain a durable processed-message checkpoint. It can re-fetch and re-write the same messages in each run under a new timestamped directory.
- `gmail_ingest_profile_dry_run.py` is count-only and does not checkpoint.
- Core `gog` watch start returns a Gmail `history_id` per docs, but the inspected OpenClaw code does not persist or use Gmail `historyId` as a durable incremental checkpoint.
- `authorize_main_gmail_readonly.py` records that `users.getProfile` returned `historyId_present`, but this is only a verification result, not connector state.

Missing or weak:

- No durable Gmail history checkpoint store for incremental sync.
- No state machine for message status transitions such as discovered, fetched, parsed, staged, handed off, failed, retried, dead-lettered.
- No persisted RFC822 `Message-ID` field in the main ingest script; it captures `Subject`, `From`, `To`, `Date`, but not the RFC822 `Message-ID` header.
- Thread IDs are captured in main ingest but not consistently across creator-email archive rows.
- Failure recovery is partial: per-message errors are logged for main ingest; creator flow keeps processed/skipped state; but there is no uniform retry/dead-letter mechanism.
- Replay/backfill exists as ad hoc CLI flags (`--backfill`, `--include-processed`, `--backfill-bodies`) rather than a deterministic connector mode with checkpoint semantics.

## Idempotency and dedupe

Idempotency is partial and inconsistent.

Current dedupe keys:

- Creator flow dedupes archive appends by `gmail_message_id` only.
- Creator flow also tracks processed IDs in `processed_ids.json`.
- Main Gmail label ingest does not dedupe across runs; it creates new run directories and can emit duplicate records for the same Gmail message in multiple runs.
- Core hook flow uses `sessionKey: "hook:gmail:{{messages[0].id}}"`, which may stabilize the agent session for a message but does not create a Media Intelligence dedupe record or prevent repeated downstream interpretation/delivery side effects.

Missing dedupe foundations:

- No stable connector-level dedupe key combining account, Gmail message ID, thread ID, RFC822 Message-ID, received/internal date, source selector, and content hash.
- No normalized idempotency table or local state database.
- No downstream Media Intelligence idempotency contract.
- No explicit replay mode that can re-emit deterministic records without duplicating staging rows.

## Output schema and Media Intelligence handoff

Current outputs are not a stable Media Intelligence connector contract.

Main Gmail label ingest emits:

- `messages_metadata.jsonl` records with fields including `gmail_message_id`, `thread_id`, `source`, `selector`, `query`, `label_id`, `subject`, `sender`, `to`, `date_header`, `sent_at`, `internal_date_ms`, `snippet`, `body_available`, `body_chars`, `body_sha256`, `body_storage_path`, `attachments`, `ingested_at`, and `gmail_mutated`.
- Local cleaned body files in `body_text/`.
- Per-run manifest/report JSON/Markdown.

Creator flow emits:

- `creator_email_items.jsonl` records with `gmail_message_id`, `source`, `subject`, `sender`, `sent_at`, status/reason, `signals`, body preview, and body metadata.
- `processed_ids.json` and skip logs.
- `substack_latest.json`, creator signal snapshots/digests, and source-registry/import consumers downstream.

Problems:

- No declared `GmailMediaItem` schema or schema version.
- Main and creator outputs differ substantially.
- Creator output mixes source metadata with interpreted `signals`, ranking, priority, and body preview.
- Raw content and normalized text are not clearly separated from interpretations in the creator archive.
- Provenance is partial: Gmail ID and source are present, but account, RFC822 Message-ID, ingestion version, connector version, query window, source-confidence, and handoff state are incomplete or inconsistent.
- Media Intelligence handoff is via local archives, snapshots, source registry, reports, and downstream scripts rather than a feature-flagged staging queue with a clear schema.

## Raw content versus interpretation

This is one of the strongest reasons to rebuild.

- OpenClaw core hook path renders Gmail message fields directly into an agent prompt. Even though external-content wrapping exists later in cron isolated-agent execution, the module’s purpose is agent execution, not ingestion.
- `fetch_creator_emails.py` performs newsletter filtering, Patreon classification, rank/priority logic, and optional LLM extraction in the same script that fetches and parses Gmail messages.
- Creator records store `signals` and `body_preview` alongside Gmail source metadata.
- Main Gmail label ingest is cleaner: it mostly fetches, parses, stores body text, attachment metadata, and manifests without summarising. This is the best code to mine.

For the future operating model, Gmail ingestion should stop at raw acquisition, normalization, metadata, provenance, and staging. Summarisation/classification should be downstream Media Intelligence interpretation with hostile-content guards.

## Security and prompt-injection risks

Positive findings:

- `src/security/external-content.ts` wraps external hook content with random boundary markers and warnings before isolated agent runs unless `allowUnsafeExternalContent` is enabled.
- `src/cron/isolated-agent/run.ts` detects external hook sessions and wraps content for hook-driven prompts by default.
- `hooks.gmail.allowUnsafeExternalContent` is marked dangerous and surfaced in security/audit code.
- `ingest_main_gmail_label.py` does not execute links or attachments; it stores cleaned text and metadata.
- Main ingest reports explicitly avoid raw body text.

Risks:

- Core Gmail hook path still intentionally turns emails into agent instructions. This creates prompt-injection exposure by design, even with wrappers.
- The dangerous `allowUnsafeExternalContent` flag exists for Gmail hooks.
- `fetch_creator_emails.py` sends raw email-derived text to an external LLM when `LLM_API_KEY` is configured and `--no-llm` is not used. The prompt contains email content without the same boundary-marker hostile-content framework used by OpenClaw hook wrapping.
- HTML is converted to text with BeautifulSoup or regex fallback; there is no quarantined raw MIME storage or robust HTML sanitization policy.
- URL extraction/following is not clearly centralized. The inspected Gmail ingestion scripts did not auto-click links, but downstream IdeaBrowser/browser workflows are adjacent and must remain separate.
- Attachments are mostly metadata-only, but separate attachment download scripts exist and must remain explicitly gated.
- Source claims, sender names, forwards, and newsletter bodies are not represented as hostile/untrusted source objects in a normalized schema.

## Attachments and links

Current behavior:

- `ingest_main_gmail_label.py` detects attachments and records filename, MIME type, size, whether an attachment ID is present, and `fetched: false`.
- `ingest_main_gmail_label.py` does not fetch attachments.
- `<workspace>/docs/main-gmail-daily-ingest.md` states attachment fetch is blocked without explicit approval.
- A separate `download_kingston_strata_pdf_attachments.py` was identified by search as adjacent Gmail/attachment functionality, but it is outside the generic ingestion module and should not be folded into the new connector without a separate attachment safety design.
- Links are not represented as extracted normalized fields in the main ingest output.
- No automatic link-following behavior was found in the inspected Gmail ingestion code paths.

Risks and gaps:

- No file-type validation pipeline for attachments at the connector layer.
- No attachment quarantine directory contract.
- No attachment hash/provenance model.
- No URL extraction field with no-follow guarantee.
- No explicit hostile-link policy in the connector output schema.

## Error handling and observability

Current observability is operational but ad hoc.

Positive findings:

- Main ingest records per-message errors in `errors.json` and includes counts in manifests/reports.
- Wrapper logs each source result and exits non-zero if any source fails.
- Token health script has safe profile-only diagnostics and scrubs common OAuth errors.
- Core Gmail watcher logs startup, address-in-use, `gog` stdout/stderr, exits, and restarts.
- OpenClaw hook HTTP handler has auth rate limiting and request size/timeouts.

Weaknesses:

- No dead-letter queue with retryable failure state.
- No connector-level metrics schema for discovered/fetched/parsed/staged/deduped/skipped/failed/retried counts.
- No stable run manifest across both main and creator Gmail flows.
- No structured checkpoint/retry relationship between a failed Gmail message and later recovery.
- Core watcher continues serving even if `watch start` fails in some paths, which may be acceptable operationally but is weak for deterministic ingestion.
- Errors can be written to ad hoc logs/reports rather than a unified observability surface.

## Tests and fixtures

Repository tests:

- `src/hooks/gmail.test.ts` tests config/path/default resolution.
- `src/hooks/gmail-watcher-lifecycle.test.ts` tests lifecycle logging and skip behavior.
- `src/hooks/gmail-setup-utils.test.ts` tests Python resolution and Tailscale error formatting.
- `src/gateway/hooks-mapping.test.ts` tests hook mapping/template behavior, including Gmail preset surfaces.
- `src/security/external-content.test.ts` tests external-content wrapping and Gmail hook session detection.

Workspace tests:

- `<workspace>/tests/test_scheduler_creator_email_static_acceptance.py` is a static acceptance test over scheduler registry/evidence roles, OAuth terms, mutation terms, and path contracts. It is not a parser/connector fixture test.
- No Gmail parser fixture test suite was found under `<workspace>/tests`.

Missing required fixtures:

- Plain text email.
- HTML-only email.
- Multipart email.
- Newsletter email.
- Forwarded email.
- Press release email.
- Email with attachments.
- Malformed email.
- Duplicate email.
- Empty body.
- Prompt-injection email.
- MIME parts with nested alternative/related structures.
- RFC822 header variants and missing headers.

The parser cannot be confidently tested offline today because parsing is embedded in live-Gmail scripts rather than a fixture-first package with pure functions and sample Gmail API message JSON.

## Compliance scorecard

| Principle                                 | Score 0-2 | Evidence                                                                                                                                    | Notes                                                                                                           |
| ----------------------------------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Deterministic                             |         1 | Main ingest is deterministic for a given live Gmail state; creator flow can invoke LLM and time-dependent runs.                             | Live mailbox dependency and interpretation logic make outputs non-deterministic.                                |
| Read-only by default                      |         1 | Workspace scripts use `gmail.readonly` and refuse mailbox mutation; core setup mutates config/Pub/Sub/Tailscale and docs include send test. | Gmail mailbox read-only is mostly good; environment mutations and agent delivery remain outside pure ingestion. |
| Sidecar-compatible                        |         0 | Gmail hook lives in OpenClaw core gateway/hooks/cron; workspace scripts are local operational scripts.                                      | No sidecar connector boundary.                                                                                  |
| Schema-driven                             |         0 | Outputs are ad hoc JSONL/manifests; no declared `GmailMediaItem` schema.                                                                    | Main and creator records diverge.                                                                               |
| Idempotent                                |         1 | Creator archive dedupes by Gmail message ID; main ingest creates duplicate run outputs.                                                     | No cross-run connector dedupe key.                                                                              |
| Replayable                                |         1 | Some backfill/include-processed flags exist; run directories preserve outputs.                                                              | No deterministic replay from checkpoint/staging store.                                                          |
| Checkpointed                              |         0 | Processed IDs exist only in creator flow; no Gmail history ID checkpoint.                                                                   | Main ingest lacks processed-message state.                                                                      |
| Fixture-tested                            |         0 | Tests cover config/hook utilities, not MIME/Gmail parser fixtures.                                                                          | No offline Gmail fixture suite found.                                                                           |
| Observable                                |         1 | Logs, manifests, error files, and watcher logs exist.                                                                                       | No unified metrics/dead-letter/retry observability.                                                             |
| Secure against hostile email content      |         1 | Core hook wrapper exists; main ingest avoids executing links/attachments.                                                                   | Creator LLM prompt path and agent-hook model remain risky.                                                      |
| Raw content separated from interpretation |         0 | `fetch_creator_emails.py` mixes fetching, filtering, LLM extraction, ranking, and archive writes.                                           | Main ingest is better but not the only current module.                                                          |
| No direct memory writes                   |         2 | Inspected Gmail scripts write local data/reports/source registry paths, not OpenClaw memory directly.                                       | Some downstream project reports/memory references exist, but ingestion modules do not directly write memory.    |
| No Gmail-specific logic in Hermes core    |         0 | `src/hooks/gmail*.ts`, config schema, gateway mappings, watcher lifecycle, docs, and cron model overrides are core surfaces.                | Gmail is embedded in general OpenClaw hook orchestration.                                                       |
| Suitable for Media Intelligence           |         0 | No stable staging schema, feature flag, provenance layer, or connector contract.                                                            | Useful source data exists, but the architecture is wrong.                                                       |

Total: 8 / 28.

## Reusable parts

Preserve or copy these concepts into a new implementation:

- Read-only scope enforcement from `<workspace>/scripts/authorize_main_gmail_readonly.py`.
- Account verification with `users.getProfile` from `authorize_main_gmail_readonly.py`, `check_creator_gmail_token_health.py`, and `ingest_main_gmail_label.py`.
- Safe OAuth error scrubbing from `ingest_main_gmail_label.py`, `authorize_main_gmail_readonly.py`, and `check_creator_gmail_token_health.py`.
- Gmail query/label selection from `<workspace>/configs/gmail/main-ingest-profile.json`, after stripping account-specific and temporary-rewire history into a clean connector config.
- Pagination loop in `ingest_main_gmail_label.py::list_message_ids`.
- Body extraction idea from `ingest_main_gmail_label.py::extract_body_and_attachments`, but rewrite it as fixture-tested pure parser code.
- Attachment metadata-only posture from `ingest_main_gmail_label.py`.
- Body hashing and separate body-file storage from `ingest_main_gmail_label.py`, but move behind a schema with raw/normalized separation.
- Per-message error accumulation from `ingest_main_gmail_label.py`.
- Local JSONL writing pattern from `ingest_main_gmail_label.py`, but make append/idempotency atomic.
- `gmail.readonly` token health check pattern from `check_creator_gmail_token_health.py`.
- External-content boundary concepts from `src/security/external-content.ts`, but apply them in downstream interpretation, not in the connector output itself.
- OpenClaw hook auth/header token hardening is useful for webhooks generally but should not be the Gmail ingestion foundation.

## Unsafe or brittle parts

Do not reuse these as the foundation:

- Core `src/hooks/gmail*.ts` as an ingestion connector. It is a Gmail-to-agent hook surface, not a deterministic source connector.
- `src/gateway/hooks-mapping.ts` Gmail preset as a Media Intelligence ingestion path. It converts email into an agent prompt.
- `src/gateway/server/hooks.ts` dispatch through isolated cron agent runs for ingestion.
- `docs/automation/gmail-pubsub.md` operational pattern as the Media Intelligence architecture. It is useful user-facing docs for hooks, not a sidecar ingest design.
- `fetch_creator_emails.py` as a foundation, because it mixes Gmail fetching, filtering, LLM extraction, ranking, body preview, processed state, archive append, snapshot writing, and downstream update semantics.
- `processed_ids.json` as the only checkpoint mechanism.
- Per-run timestamped directories as dedupe/idempotency.
- Account-specific config with temporary OAuth rewiring history embedded in the live profile.
- Credential files under `<workspace>/scripts/`, even with `0600` permissions; move future connector secrets under a dedicated credential directory and keep scripts source-only.
- Prompt templates that include raw email body text in agent prompts.
- Optional external LLM extraction inside ingestion.

## Fix-versus-rebuild effort

Patch current module:

- likely work required
  - Split parsers out of live Gmail scripts.
  - Create fixture suite.
  - Add schema versioning.
  - Add checkpoint database or durable state file.
  - Add idempotent dedupe key and staging writer.
  - Remove interpretation/LLM/ranking from fetch path.
  - Untangle source registry and digest side effects.
  - Remove Gmail-specific source logic from core OpenClaw hook path or keep it only as legacy hooks.
  - Normalize main-Gmail and creator-Gmail outputs into one schema.
- risks
  - High regression risk because scripts are live operational jobs.
  - Multiple account/source assumptions are embedded in configs and scripts.
  - Fixes would touch production-ish local workflows, LaunchAgents, output paths, and downstream consumers.
  - Hard to prove safety without a fixture-first rewrite anyway.
- missing foundations
  - No connector interface.
  - No state/checkpoint model.
  - No offline parser test corpus.
  - No schema contract.
  - No Media Intelligence staging feature flag.

Rebuild with Codex:

- likely work required
  - Build a new sidecar package/CLI with pure parser functions and Gmail API adapter boundary.
  - Add fixtures before live API access.
  - Implement `GmailMediaItem` schema and JSONL dry-run writer.
  - Implement SQLite or JSON state store with Gmail message/history checkpoints and idempotent dedupe keys.
  - Add replay/backfill/incremental modes.
  - Add hostile-content handling flags and provenance fields.
  - Add feature-flagged Media Intelligence staging handoff.
  - Keep legacy scripts untouched until the new sidecar validates against fixtures and dry-run comparisons.
- risks
  - Need careful path/config migration planning.
  - Need mapping from legacy outputs to the new schema.
  - Need staged validation against live Gmail later, under explicit approval.
- advantages
  - Avoids deep surgery on brittle live scripts.
  - Creates the desired connector boundary directly.
  - Enables fixture-first testing before any live Gmail access.
  - Allows legacy code to continue while the new sidecar proves itself in dry-run mode.
  - Keeps source-specific logic outside OpenClaw core orchestration.

## Final recommendation

Choose one:

4. SCRAP AND REBUILD WITH CODEX

The current module should be classified as **SCRAPPED AND REBUILT WITH CODEX**, with selected fragments mined. It fails five or more major areas: sidecar boundary, schema contract, checkpointing, fixture testing, raw-versus-interpretation separation, Media Intelligence suitability, and Gmail-specific core leakage. Security and idempotency are partially addressed but fundamentally not robust enough for a future Media Intelligence ingestion source. The rebuild should not start by modifying OpenClaw core; it should create a new sidecar connector and keep current workflows as legacy inputs/comparison baselines until replaced.

## Proposed next action

If SCRAP AND REBUILD WITH CODEX:

- define the first Codex build task
  - Build a new fixture-first Gmail ingestion sidecar with no live Gmail dependency by default. Start with pure parsing, schema, state/dedupe interfaces, CLI dry-run from fixtures, and JSONL staging output. Do not touch legacy scripts or OpenClaw core.
- define the target sidecar location
  - Preferred target: `<workspace>/connectors/gmail_media_sidecar/`
  - Supporting test fixtures: `<workspace>/connectors/gmail_media_sidecar/tests/fixtures/gmail/`
  - Dry-run staging output: `<workspace>/reports/media_intelligence_triage/gmail_sidecar_dry_runs/`
  - Future feature-flagged handoff output: `<workspace>/data/media_intelligence/staging/gmail/`
- define the minimum v0 feature set
  - `GmailMediaItem` schema with schema/version fields.
  - Fixture parser for Gmail API `messages.get format=full` JSON.
  - Raw MIME-ish source payload separated from normalized text metadata.
  - Provenance fields: account, source profile, selector/query/label, Gmail message ID, thread ID, RFC822 Message-ID, internal date, Date header, sender, recipients, subject, labels, snippet, body hash, ingestion run ID, connector version.
  - Attachment metadata only; no downloads.
  - URL extraction as inert strings; no link following.
  - Stable dedupe key.
  - Durable checkpoint store interface with SQLite preferred for v0.
  - CLI modes: `parse-fixtures`, `dry-run-jsonl`, `backfill --dry-run`, `replay --from-state`, and later `live --readonly` behind explicit config.
  - Dead-letter/error JSONL for failed parse/fetch items.
  - Fixture tests for all required email shapes.
  - Media Intelligence staging handoff behind `--enable-media-staging` feature flag, default off.

## Suggested Codex prompt if rebuild is recommended

```text
Task: Build a new Gmail ingestion sidecar for OpenClaw Media Intelligence without modifying OpenClaw core or legacy Gmail scripts.

Repository/path:
- Work under <workspace>/connectors/gmail_media_sidecar/ only.
- Do not edit OpenClaw core source files.
- Do not edit existing Gmail ingestion scripts.
- Do not read token files, client-secret files, private email bodies, or live Gmail content.
- Do not require live Gmail credentials for tests.

Context:
We audited the current Gmail ingestion implementation and classified it as SCRAPPED AND REBUILT WITH CODEX. Useful fragments exist in the legacy scripts, but the architecture is wrong for the new operating principles. The replacement must treat Gmail as a source connector feeding Media Intelligence, not as an agent workspace.

Constraints:
- Audit/build is local-only and fixture-first.
- No Hermes/OpenClaw core changes.
- No production config changes.
- No Gmail sends, replies, drafts, deletes, trash, archive, mark-read, label changes, or mailbox mutations.
- No live Gmail access unless a later explicit approval enables a readonly dry run.
- No direct memory writes.
- Source email content is hostile/untrusted.
- Raw content must be separated from interpreted content.
- Do not run external LLM calls.
- Do not follow links.
- Do not download attachments in v0.

Required work:
1. Create a new sidecar package/CLI under <workspace>/connectors/gmail_media_sidecar/.
2. Implement a normalized GmailMediaItem schema with at least:
   - schema_name
   - schema_version
   - connector_version
   - ingestion_run_id
   - source_account
   - source_profile_id
   - source_selector with query/label_id/label_name
   - gmail_message_id
   - gmail_thread_id
   - rfc822_message_id
   - internal_date_ms
   - date_header
   - received_at or sent_at normalized ISO timestamp when available
   - sender
   - recipients
   - subject
   - labels
   - snippet
   - raw_payload_ref or raw_payload_sha256
   - normalized_text_ref or normalized_text_sha256
   - body_available
   - body_chars
   - attachments metadata only
   - extracted_urls inert list
   - provenance object
   - hostile_content flag/notes
   - dedupe_key
3. Implement pure parser functions for Gmail API message JSON fixtures.
4. Implement fixture-first tests before any live Gmail adapter work. Include fixtures for:
   - plain text email
   - HTML-only email
   - multipart email
   - newsletter email
   - forwarded email
   - press release email
   - email with attachments
   - malformed email
   - duplicate email
   - empty body
   - prompt-injection email
5. Implement deterministic JSONL dry-run output.
6. Implement durable checkpoint/state store interface, preferably SQLite, with:
   - processed Gmail message IDs
   - Gmail thread IDs
   - RFC822 Message-ID values
   - history ID checkpoint field, even if live incremental sync is stubbed for v0
   - run records
   - failed/dead-letter records
7. Implement idempotent dedupe key generation using account + gmail_message_id + thread_id + rfc822_message_id + internal_date_ms + normalized text hash where available.
8. Implement CLI commands:
   - parse-fixtures
   - dry-run-jsonl --fixtures <dir> --out <path>
   - replay --state <path> --out <path>
   - backfill --dry-run, with live Gmail adapter stubbed or disabled unless readonly config is supplied later
9. Implement Media Intelligence staging handoff behind a feature flag:
   - default off
   - when enabled, write only JSONL staging records to <workspace>/data/media_intelligence/staging/gmail/
   - do not call downstream promotion, Kanban, memory, Telegram, or agent workflows.
10. Add tests and a README documenting boundaries, no-mutation guarantees, and live-access approval requirements.

Validation commands:
- Run the sidecar unit tests.
- Run fixture parse command against all fixtures.
- Run dry-run JSONL command twice and prove byte-stable output for the same fixtures.
- Verify no files outside <workspace>/connectors/gmail_media_sidecar/ and approved dry-run output paths were changed.
- Verify no token/client-secret files were read.

Required final output:
- Files created/changed.
- Tests run and exact pass/fail output.
- Generated dry-run JSONL path and SHA256.
- Non-execution flags: live_gmail_access=false, mailbox_mutation=false, external_llm_calls=false, link_following=false, attachment_downloads=false, openclaw_core_changes=false, memory_writes=false.
- Any unresolved risks or schema questions.
- Recommended next Hermes validation action.
```

## Durable project updates to promote

- Architecture decision: current Gmail ingestion should not remain the Media Intelligence foundation; classify it as **SCRAPPED AND REBUILT WITH CODEX**, while mining selected read-only OAuth/list/parse/attachment-metadata/reporting fragments.
- Module classification: OpenClaw core Gmail Pub/Sub hooks are legacy agent-trigger infrastructure, not the target Media Intelligence ingestion connector.
- Blocker: no fixture-first parser suite, no stable `GmailMediaItem` schema, no Gmail history checkpoint, and no connector-level idempotency store currently exist.
- Implementation status: current workspace scripts can continue as legacy operational workflows, but should not be expanded as the new Gmail Media Intelligence architecture.
- Next step: create `<workspace>/connectors/gmail_media_sidecar/` with fixture-first tests, dry-run JSONL output, durable checkpoint store, idempotent dedupe key, and feature-flagged Media Intelligence staging.
- New operating rule: Gmail ingestion modules must stop at read-only acquisition, normalization, provenance, state, dedupe, and staging; summarisation, ranking, LLM interpretation, memory writes, Kanban actions, notifications, and source-specific orchestration must live downstream behind explicit gates.
