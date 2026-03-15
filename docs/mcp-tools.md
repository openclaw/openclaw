# Radar MCP Tools

## `analyze_code_snippet`

- Purpose: review an isolated code snippet for Radar-relevant defensive issues
- Input:
  - `snippet`
  - `language?`
  - `logical_path?`
  - `notes?`
  - `minimum_severity?`
- Output:
  - structured review result with summary, findings, and unverified notes
- Use when:
  - reviewing a pasted helper, component, or route fragment
- Limitations:
  - no repo context outside the supplied snippet

## `analyze_route`

- Purpose: review a route handler for trust-boundary, auth, IDOR, and validation risks
- Input:
  - `method`
  - `route_path`
  - `handler_source`
  - `notes?`
- Output:
  - structured review result
- Use when:
  - reviewing Next.js or server route logic
- Limitations:
  - sees only the supplied handler source

## `analyze_sql_policy`

- Purpose: review SQL / RLS text for permissive or misaligned policy behavior
- Input:
  - `table`
  - `policy_name?`
  - `sql`
  - `assumed_access_pattern?`
- Output:
  - structured review result
- Use when:
  - checking policies, migrations, or DDL snippets
- Limitations:
  - no live database introspection

## `threat_model_flow`

- Purpose: threat-model a described product flow without interacting with live systems
- Input:
  - `flow_name`
  - `actors[]`
  - `assets[]`
  - `steps[]`
  - `trust_boundaries[]?`
  - `notes?`
- Output:
  - structured review result
- Use when:
  - analyzing OTP, webhook, bid, review, or admin flows
- Limitations:
  - based only on the supplied narrative

## `summarize_finding`

- Purpose: rewrite one structured finding for a target audience
- Input:
  - `finding`
  - `audience`
- Output:
  - `audience`
  - `summary`
  - `source_finding`
- Use when:
  - adapting a finding for engineering, founders, support, or audit review
- Limitations:
  - does not generate new evidence

## `review_auth_boundary`

- Purpose: route review with extra focus on auth, OTP, admin, ownership, and rate-limiting boundaries
- Input:
  - `route_path`
  - `handler_source`
  - `client_flow?`
  - `notes?`
- Output:
  - structured review result
- Use when:
  - a route participates in login, signup, verification, or privileged access
- Limitations:
  - heuristic review only; no session replay or live execution

## `review_rls_assumptions`

- Purpose: compare RLS text with the API assumptions described by the caller
- Input:
  - `table`
  - `policy_sql`
  - `api_assumption_summary`
  - `notes?`
- Output:
  - structured review result
- Use when:
  - validating that API-layer claims and database-layer policy are aligned
- Limitations:
  - cannot inspect the live schema or policy graph
