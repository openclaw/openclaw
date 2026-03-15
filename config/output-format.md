# Output Format

Every defensive review finding must use this exact shape.

## Required fields

- `finding`
- `severity`
- `affected_area`
- `preconditions`
- `why_it_matters`
- `evidence`
- `recommended_fix`
- `regression_test_idea`

## Severity scale

- `critical`
- `high`
- `medium`
- `low`
- `info`

## MCP tool result shape

All review tools except `summarize_finding` return:

- `tool`
- `target`
- `summary`
  - `finding_count`
  - `highest_severity`
  - `review_recommendation`
  - `applied_analyzers`
- `findings`
- `unverified`

## Finding JSON example

```json
{
  "finding": "Route appears to trust actor identity from request-controlled input",
  "severity": "high",
  "affected_area": "POST /api/jobs/[id]/bids",
  "preconditions": ["The caller can influence the supplied identity field."],
  "why_it_matters": "This can open a direct IDOR path.",
  "evidence": ["Matched pattern: body.userId"],
  "recommended_fix": [
    "Bind identity checks to the authenticated actor.",
    "Ignore caller-supplied actor identifiers for authorization."
  ],
  "regression_test_idea": "Repeat the same request with another user's identifier and assert denial."
}
```

## Reporting standard

- no raw secrets in examples or outputs
- no exploit instructions
- no PASS claims without evidence
- anything unproven must stay in `unverified`
