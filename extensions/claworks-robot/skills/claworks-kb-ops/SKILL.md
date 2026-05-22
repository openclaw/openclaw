# ClaWorks KB Ops

Use Twin document KB tools for ingest, refinery, publish, and citation-backed search.

## When to use

- Operator drops files or pastes text that must become durable KB documents.
- Agent must cite `document_id`, `layer`, and `citation` in answers.
- Batch folder sync or HITL-gated publish workflows.

## Tool map

| Goal                       | Tool / Playbook                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Search published knowledge | `cw_kb_search` (optional `namespace`, `layer`)                                       |
| Ingest draft document      | `cw_kb_ingest_document` (`auto_publish: false`)                                      |
| Lint before publish        | `cw_kb_lint_document`                                                                |
| Publish after lint         | `cw_kb_publish`                                                                      |
| List drafts                | `cw_kb_list_documents` (`status: draft`)                                             |
| Batch folder intake        | `cw_kb_create_ingest_job` + `cw_kb_process_ingest_job` or playbook `kb_intake_batch` |
| HITL publish               | playbook `kb_publish_hitl`                                                           |
| Vector sync after batch    | `cw_kb_flush`                                                                        |

## Citation discipline

- Prefer results with `citation`, `document_id`, and `layer`.
- L0 = standards/regulations; L1 = OEM/manual; L2 = enterprise SOP; L3 = station/case; L4 = draft.
- Do not treat vector-only snippets as authoritative without document metadata.

## REST parity

- `GET /v1/kb/documents`, `POST /v1/kb/documents`, `POST /v1/kb/documents/:id/publish`
- `POST /v1/kb/ingest/jobs`, `POST /v1/kb/ingest/jobs/:id/process`
