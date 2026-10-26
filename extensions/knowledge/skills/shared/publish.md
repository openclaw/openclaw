# Publish pages

## Rules for every write

- Each distinct write gets a fresh lowercase UUID `requestId`. Keep the exact
  payload so you can replay it. Pass imported text as JSON arguments, never
  through shell interpolation.
- Creates omit `id`, `expectedRevision` and `expectedHash`; the backend picks the
  ID and filename. Edits supply all three from a current read.
- Collections (`aliases`, `tags`, `dependencies`, `fields`) replace when supplied
  and are preserved when omitted. Empty clears. Supplying `fields` replaces the
  whole object.
- `save_page` cannot set lifecycle, entity IDs, claim kinds, relationships or
  arbitrary frontmatter. Don't smuggle them into `fields`. Unsupported facts go
  in attributed prose.
- Page body limit is 48,000 characters. Keep long originals attached; never
  truncate them to fit.
- Search before creating. Match source ID, URL, original hash, title and date,
  not just a similar title.

## Create, then link

You can't predict paths. Publish a new page with its evidence first, then use the
returned path for self-citations and cross-links in a follow-up edit. Link to
other pages only after they exist. Reread revision/hash before each follow-up
edit.

## Edit an existing page

- Small change: `knowledge_edit_body` with UTF-16 `start`/`end` offsets from a
  `knowledge_record` content read, the replacement, a reason and the
  vault/revision/hash/ontology fences. Equal offsets insert; empty replacement
  deletes.
- Full replacement: read the entire body first (follow `content.nextOffset`;
  compare hashes across pages). Never edit from a truncated read.
- Request `metadataView: "full"` before changing domain fields. Preserve
  unrelated prose and metadata.

## Publish related records together

`knowledge_publish_batch` publishes 1–25 items (max 1 MiB) under one
`requestId`, `expectedVaultId` and `expectedOntologyFingerprint`.

- Each item: `key`, `kind` (`page`, `claim`, `relationship`) and an ordinary
  write `input` without its own request/vault/ontology fields.
- Keys match `^[a-z][a-z0-9_-]{0,39}$` (`morgan_hale`, not `MorganHale`).
- Refer to batch items with `@key` in any ID position, including forward
  references. In bodies, `[[@key|Label]]` becomes a stable-ID link at publish.
  Page edits use an existing `id`, never `@key`.
- Upload originals first; inline `source` text is not accepted in a batch.
- Optional `source: {provider, key, sha256}` binds the batch to one original.
  Unchanged source returns the prior receipt and ignores the new input. Changed
  bytes need `expectedPreviousRequestId` from `knowledge_source_check`, after
  you reconcile existing outputs. Use separate stable keys for split meetings and
  follow-up batches.

Use individual tools (`knowledge_save_page`, `knowledge_create_claim`,
`knowledge_create_relationship`) for isolated or follow-on writes.

If anything is uncertain after a write, read [recovery](recovery.md).
