# Gmail Media Intelligence Sidecar

This sidecar is a fixture-first replacement path for Gmail Media Intelligence ingestion.
It is source-specific and emits normalized records; it does not modify Hermes/OpenClaw core
or the legacy Gmail hook/ingestion modules.

## Scope

The v0 sidecar parses synthetic Gmail API `messages.get(format=full)` fixtures, normalizes
source metadata and body text, extracts inert URLs, records attachment metadata, generates
deterministic dedupe keys, writes dry-run JSONL, and supports a local checkpoint store.

It does not summarize, classify, rank, write memory, trigger agents, follow links, download
attachments, call external models, call Gmail, or require Gmail credentials.

## File Layout

- `models.py`: `GmailMediaItem` schema and nested metadata records.
- `parser.py`: pure parser for fixture Gmail message JSON.
- `dedupe.py`: stable hash and dedupe key helpers.
- `checkpoint.py`: local JSON checkpoint store interface.
- `jsonl_writer.py`: deterministic JSONL writer.
- `staging.py`: feature-flagged Media Intelligence staging writer stub.
- `cli.py`: fixture replay and dry-run commands.
- `fixtures/gmail/`: synthetic fixture corpus.
- `tests/`: offline unit tests.

## Security Assumptions

All email bodies, HTML, links, headers, sender claims, and attachment metadata are hostile
and untrusted source input. Email content must never become agent instructions.

The sidecar handles hostile input by:

- decoding body content only as source text;
- converting HTML to text without executing scripts or trusting markup;
- extracting URLs as strings only;
- never following links;
- recording attachment metadata only;
- never opening, downloading, hashing, or inspecting attachment bytes;
- storing explicit `hostile_content` flags on every item;
- avoiding any fields for summaries, classifications, rankings, memory writes, or decisions.

## Data Model

The normalized record is `GmailMediaItem` with:

- schema and connector version fields;
- ingestion run ID;
- source account/profile/selector;
- Gmail message ID and thread ID;
- RFC822 `Message-ID`;
- subject, sender, recipients, labels, snippet;
- received/internal timestamp and Date header normalization;
- plain body text, HTML-derived text, selected normalized body text, and hashes;
- raw payload hash and size, not a trusted instruction surface;
- inert extracted URLs;
- attachment metadata with `fetched=false`;
- provenance;
- hostile-content flags;
- deterministic dedupe key.

The schema intentionally has no interpretation fields.

## CLI

Run from the repository root:

```sh
python3 -m connectors.gmail_media_sidecar.cli parse-fixtures \
  --fixtures connectors/gmail_media_sidecar/fixtures/gmail
```

Write deterministic dry-run JSONL:

```sh
python3 -m connectors.gmail_media_sidecar.cli dry-run-jsonl \
  --fixtures connectors/gmail_media_sidecar/fixtures/gmail \
  --out /tmp/gmail-sidecar-dry-run.jsonl
```

Use a local checkpoint:

```sh
python3 -m connectors.gmail_media_sidecar.cli dry-run-jsonl \
  --fixtures connectors/gmail_media_sidecar/fixtures/gmail \
  --out /tmp/gmail-sidecar-dry-run.jsonl \
  --state /tmp/gmail-sidecar-checkpoint.json
```

The Media Intelligence staging stub is off by default. When explicitly enabled, it writes
JSONL only and does not promote, summarize, classify, or call downstream systems:

```sh
python3 -m connectors.gmail_media_sidecar.cli dry-run-jsonl \
  --fixtures connectors/gmail_media_sidecar/fixtures/gmail \
  --out /tmp/gmail-sidecar-dry-run.jsonl \
  --enable-media-staging \
  --staging-dir data/media_intelligence/staging/gmail
```

## Observability

CLI reports include:

- `parsed_count`
- `skipped_count`
- `duplicate_count`
- `malformed_count`
- `failed_count`
- `written_count`
- staging status

## V0 Limitations

- Fixture-only; no live Gmail adapter.
- JSON checkpoint store, not SQLite.
- No Gmail history sync implementation.
- No attachment quarantine pipeline.
- No raw MIME archival contract.
- HTML conversion is conservative text extraction, not a sanitizer for rendering.
- Media Intelligence handoff is a JSONL staging stub only.

## Future Gmail API Integration Plan

Future live integration must be a separate, explicit read-only adapter behind configuration
and approval. It should:

- require `https://www.googleapis.com/auth/gmail.readonly` only;
- refuse Gmail mutation scopes;
- avoid reading credentials in tests;
- list/fetch messages through a narrow adapter that returns the same fixture-shaped JSON;
- persist Gmail `historyId` checkpoints;
- preserve deterministic parser behavior by replaying captured fixture payloads;
- keep attachment downloads disabled unless a separate quarantine design is approved;
- keep Media Intelligence promotion behind a staging boundary;
- never route Gmail content into Hermes/OpenClaw agent prompts or memory directly.
