# Filing resolver

This sample uses `knowledge-default@1.0.0` unchanged. The ontology, not this guide, is authoritative.

- People: `people/`.
- Companies and other organizations: `companies/`, canonical type `company`; `organization` is a query alias.
- Projects: `projects/`; optional project status is distinct from record lifecycle.
- Meetings: `meetings/`.
- Concepts: `wiki/concepts/`; notes: `notes/`.
- Independent claims: `claims/`; explicit relationships: `relationships/`.
- Retained source artifacts: `artifacts/`.

One primary home per record. Explicit type wins; absent types may be classified from ordered ontology path prefixes. Stable IDs, not paths or names, establish identity. Reads never rewrite or move files.
