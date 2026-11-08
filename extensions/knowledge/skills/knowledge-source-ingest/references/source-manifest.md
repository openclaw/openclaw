# Source manifest protocol

`knowledge-source-manifest-v1` is JSON Lines. The first line is a header containing the format, stable provider/source key, exact half-open coverage interval, completeness, observation time, and item count. Remaining lines are sorted by stable item ID and contain the item ID, SHA-256, and optional occurrence timestamp.

The snapshot command accepts normalized JSONL rows with `id`, optional `occurred_at`, and either `sha256` or `payload`/`data`. Without `sha256`, it hashes a canonical JSON representation of the payload. Timestamps are normalized to UTC. Duplicate IDs reject the snapshot.

The planner uses the newest `observed_at` version of each prior item, independent of argument order. It reports interval coverage plus added, changed, unchanged, deleted, and unresolved-missing IDs. A missing prior item is `deleted` only when it has an occurrence timestamp inside the current observation range; otherwise it is unresolved or outside the comparison range. Only a complete current snapshot permits treating in-range absence as deletion evidence.

The manifest is an efficient retained index, not the original source and not a Knowledge truth ledger. Derived pages and assertions retain exact source evidence. The snapshot page makes future attempts naturally discover prior coverage through ordinary Knowledge lookup, fields, attachments, and dependencies.
