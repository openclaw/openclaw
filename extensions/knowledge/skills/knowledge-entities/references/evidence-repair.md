# Evidence repair

Only for an authorized repair of a page's evidence set, not routine enrichment.

- Use returned resolved evidence as-is, including its `source` ID. Source
  descriptors are shared within the vault scope; don't re-upload originals or
  invent IDs to shrink a profile. Keep passage ranges, quotes and attribution.
- To replace the evidence set, read the complete State, Timeline and annotation
  support first. Call `knowledge_reconcile_evidence` with a reason, the exact
  vault/ontology/revision/hash fences and the reviewed complete `evidence` set.
  Preview with `dryRun: true`; apply with `dryRun: false` only after inspecting
  the result.
- Keep historical Timeline support even if State no longer uses it. Annotation
  support is retained automatically. Removing an association deletes no
  originals or history.
- For an explicitly requested representation migration, omit `evidence` and set
  `representation: compact` or `expanded`. Don't migrate or save a no-op page
  just to get a receipt.
- Afterward, verify the complete body, unchanged metadata, retained evidence and
  the published revision/hash.
