# STORY-06 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-13 PST
Story: `STORY-06: Incident templates + evidence requirement policy model`

## Goal

Implement a deterministic, versioned incident-template policy model that defines closeout evidence/checklist requirements per incident type and supports fail-closed readiness evaluation.

## Artifacts

- Template data file:
  - `dispatch/policy/incident_type_templates.v1.json`
- Rule engine module:
  - `dispatch/workflow-engine/rules/closeout-required-evidence.mjs`

## Template Schema (v1)

Each template entry contains:

- `incident_type` (string, normalized uppercase key)
- `version` (string)
- `required_evidence_keys` (non-empty string array)
- `required_checklist_keys` (non-empty string array)

Template set container:

- `schema_version` (string)
- `templates` (non-empty array of template entries)

Validation rules:

- duplicate incident types are rejected fail-closed
- invalid JSON or invalid field shapes are rejected fail-closed

## Loader Contract

`loadIncidentTemplateSetFromFile(filePath?)`

- reads JSON
- validates schema
- normalizes and freezes deterministic structure
- throws `IncidentTemplatePolicyError(code="INVALID_TEMPLATE_SET")` on invalid input

## Evaluation Contract

`evaluateCloseoutRequirements(input, templateSet?)`

Input shape:

- `incident_type` (required)
- `evidence_items` (optional; array of evidence keys or `{key}` objects)
- `checklist_status` (optional; object with boolean flags)

Deterministic output:

- `ready` (boolean)
- `code` (`READY|TEMPLATE_NOT_FOUND|MISSING_EVIDENCE|MISSING_CHECKLIST|MISSING_REQUIREMENTS`)
- `incident_type`
- `template_version`
- `missing_evidence_keys` (sorted)
- `missing_checklist_keys` (sorted)

Fail-closed behavior:

- unknown incident type -> `TEMPLATE_NOT_FOUND`
- missing required evidence/checklist -> non-ready status with explicit missing lists

## Acceptance Coverage

- incident/evidence template model implemented
- required evidence gates representable per incident type
- completion-readiness check consumes template requirements deterministically
