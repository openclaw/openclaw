---
summary: "How Knowledge retains original source files, identifies sources, cites passages, and reconciles page evidence"
read_when:
  - You are attaching original documents, transcripts, or media to Knowledge records
  - You need to know where Knowledge stores evidence files and how they are verified
  - You are migrating or replacing the evidence set on a Knowledge page
title: "Knowledge evidence files"
sidebarTitle: "Evidence files"
---

How Knowledge keeps original sources and cites them. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

Evidence is retained as original files. Each source has an immutable descriptor
with its retained path, SHA-256 hash, origin attribution, and optional filename,
media type, and size. Records cite a source by descriptor ID, optionally with an
inclusive line range, an exact quote, or a citation-specific attribution.

There is no evidence-count cap and no source-length cap. Pages may omit evidence;
claims and relationships require it.

## Upload and download

For a file already acquired in the host-selected workspace, prefer
`knowledge_attach_file`. Supply `filePath`, its observed SHA-256 as `sha256`, a
fresh request UUID, filename, attribution, and the observed `expectedVaultId`.
The plugin streams bounded chunks internally and returns only the attachment
receipt; the model does not copy or generate encoded source bytes. Retry with
the identical arguments after an interruption. The source must remain unchanged.

This operation accepts only regular files within the active host workspace
(`fsPolicy.root` when pinned), rejects symbolic links and hardlinks, and is not
available for sandbox paths or operator actions. It does not grant arbitrary
Gateway-file access. Remote and sandbox clients must chain authorized
file-reading results directly into `knowledge_attach` programmatically, without
printing or regenerating base64 through the model.

`knowledge_attach` uploads bytes in sequential chunks of at most 48 KiB decoded,
with a stable request UUID and unchanging filename, media type, and attribution.
The chunk size bounds each call, not the file.

- Chunks are journaled in the store's `state.sqlite`. Retries compare offset,
  hash, size, final flag, and metadata.
- The final chunk installs the complete original at
  `<partition>/artifacts/<requestId>/<filename>` without overwriting an existing
  file. Only chunk hashes and receipts stay in SQLite.
- Uploading does not publish a page. Append the returned evidence with
  `knowledge_save_page` `attachments`; revision checks still apply.
- Failed or discarded page saves do not delete uploaded originals. There is no
  automatic attachment garbage collection.

`knowledge_attachment` returns original bytes in chunks of at most 32 KiB
decoded; follow `nextOffset`. Downloads require a matching reference and hash on
a record in the authorized partition.

No tool accepts an arbitrary host path. Retained-file reads reject symlinks,
hardlinks, unsafe paths, non-regular files, and files that change while being read.
Originals are hashed with streaming reads.

PDFs and media are retained and downloadable. Knowledge does not extract text,
run OCR, or transcribe. The Control UI offers downloads from **File details →
Retained originals**; source HTML and SVG are never rendered as trusted content.

## Source identity

Descriptors live at `<partition>/artifacts/sources/<id>.json`. The ID is the
SHA-256 of the canonical descriptor JSON. Path, content hash, and origin
attribution all contribute, so equal bytes from different origins stay
separate sources. Changed or redacted bytes need a new descriptor.

```yaml
evidence:
  - source: <64-character-descriptor-id>
    start_line: 12
    end_line: 18
    attribution: Speaker attribution for this passage
```

A citation's `attribution` overrides the source attribution for that passage
only. Resolution happens after partition authorization; a digest is an identity,
not an access credential. Copying a record alone does not copy its source.

Back up descriptor sidecars together with originals and record history.
Removing a citation never deletes a descriptor or original.

## Git and large files

Non-media originals below 100 MiB are committed to the store's
[local history](/plugins/knowledge/local-history) as exact blobs. Media and larger
originals stay in the vault outside automatic Git snapshots; their references
remain in record history. There is no cloud storage backend. Back up the vault
directory and `state.sqlite`, not only Git.

## Reconcile or migrate page evidence

`knowledge_reconcile_evidence` changes one record's evidence representation or
replaces an active page's current evidence set. It needs the exact vault,
ontology fingerprint, revision, and hash, a request UUID, and a reason. Read the
complete page, its Timeline, annotations, and relevant source passages first.

1. Run with `dryRun: true` and choose `representation: "compact"` or
   `"expanded"`. Omit `evidence` for a representation-only migration. Review the
   byte and association counts; a preview publishes nothing.
2. To replace an active page's support, supply the reviewed complete `evidence`
   set. Keep support for historical Timeline statements as well as current
   State. Annotation evidence stays attached automatically. Do not remove a
   source only because the prose no longer mentions it.
3. Apply with `dryRun: false` and the same current preconditions. The body,
   unrelated metadata, source files, descriptors, other records, and old
   revisions are preserved.
4. Read the result back and verify evidence, revision, and hash.

Claims and relationships change support through
[corrections](/plugins/knowledge/corrections) or `knowledge_annotate`, not this
tool. `expanded` writes full evidence fields as a new revision; it is a data
format choice, not a plugin downgrade path. There is no automatic bulk migration,
citation pruning, or source deletion.
