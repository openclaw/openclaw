---
name: uk-retail-apprenticeship-hunter
description: Hunt UK retail apprenticeship vacancies with strict verification and staged control. Critical rule: for nonstop requests, NEVER start cron first; return first 50, then ask user to choose [1] next 50 or [2] continuous until stop.
---

# uk-retail-apprenticeship-hunter

Run a strict, fail-closed vacancy hunt for UK retail apprenticeships.

## Primary control rule (highest priority)

- If user asks for nonstop/keep searching: do one immediate batch (`maxResults=50`) and return results first.
- Do **not** schedule cron/recurring mode until user explicitly picks option `[2] continuous until stop`.

## Operating rules

- Use UK-only sources and UK-only location filters.
- Use `web_search` first. Use `web_fetch` only to verify candidate vacancy URLs.
- Never call `edit` for vacancy hunting or planning.
- Use `write` only when creating output artifacts (CSV/PDF/notes).
- Never output tool-call JSON to the user.
- Never output placeholder or synthetic links.
- If a result cannot be verified as live and in-scope, exclude it.
- If no verified results exist for the cycle, output `TOOL_FAILED`.
- For `web_fetch`, never pass null parameters. Omit `maxChars` or set `maxChars >= 100`.
- For high-volume/nonstop requests, do not run endlessly without a checkpoint: deliver first batch, then ask how to continue.

## Required intake

Collect or infer these fields before starting:

- `area`: UK target area (city/county/postcode). Default: `Warwickshire`.
- `radius_km`: numeric radius. Default: `20`.
- `sector`: fixed to `retail` unless user broadens scope.
- `cadence_minutes`: recurring check interval. Required only for nonstop mode. Default: `30`.
- `stop_phrase`: exact stop command. Required only for nonstop mode. Default: `STOP UK RETAIL HUNT`.
- `batch_size`: first delivery size. Default: `50`.
- `continuation_mode`: `next_50` or `continuous_until_stop`. Default: `next_50` checkpoint after first batch.

If fields for single-run mode are present or inferable, start immediately and do not ask confirmation.
Ask one compact clarification only when a required field is truly missing.
Infer continuation intent from plain English:

- "continue", "more", "next", "keep going" => `next_50`
- "run nonstop", "until I stop", "keep searching" => `continuous_until_stop`

## Search and verification workflow

1. Build focused search queries for UK retail apprenticeships in the target area.
2. Prioritize these domains:
   - `findapprenticeship.service.gov.uk`
   - `reed.co.uk`
   - `totaljobs.com`
   - `uk.indeed.com`
3. Exclude non-UK postings (for example: USA, United States, Canada, Ontario, Alberta, British Columbia).
4. Pick candidate vacancy-page URLs only (no homepage, no category shell, no generic search page).
5. Verify each candidate with `web_fetch`.
6. If the user asked for high volume/nonstop, collect and present the first 50 (`maxResults=50`) before deciding follow-on mode.
7. Keep only verified, live, in-area, apprenticeship/trainee postings.
8. Deduplicate by normalized URL + employer + title.
   - Keep a dedupe memory window of 120 seconds per cycle window.
   - For "next 50", pass prior batch URLs via `excludeUrls` to avoid repeats.
9. Rank by entry requirement, lowest to highest:
   - No formal qualifications / willing to train
   - GCSE/equivalent
   - A-level/Level 3
   - Level 4-5/Foundation
   - Bachelor required
   - Postgraduate+
   - Not stated (always last)

## Sub-agent orchestration (parallel precision mode)

Use sub-agents to improve precision and speed when the user asks for nonstop or high-volume hunting.

1. Spawn focused sub-agents with `sessions_spawn`, one per source or task:
   - Source scouts: `findapprenticeship.service.gov.uk`, `reed.co.uk`, `totaljobs.com`, `uk.indeed.com`
   - Verifier worker: URL liveness + vacancy-page checks
   - Normalizer worker: dedupe + qualification-band classification
2. Keep each spawned task narrow and explicit:
   - Include area, radius, UK-only geo constraints, and exclusion terms.
   - Require only vacancy-page URLs (no home/search shell pages).
3. Use bounded runtime for each worker (`runTimeoutSeconds`) and continue with partial valid results if a worker times out.
   - Retry a failed worker at most two times before marking it failed.
4. Aggregate worker results in the parent run only. The parent is the single reporter to the user.
5. If all workers fail or return no valid rows, output `TOOL_FAILED`.

Sub-agent task template:

- `task`: "Find LIVE retail apprenticeship vacancies in <area> within <radius_km> km, UK only. Return candidate vacancy-page URLs only."
- `label`: short source label (for example `src-reed`, `src-totaljobs`)
- `runTimeoutSeconds`: 60-120 (based on cadence and latency)

Operational control:

- For manual operator stop: `/subagents kill all`
- Global stop phrase remains: `STOP UK RETAIL HUNT`

## Output contract

Return concise, deterministic output:

1. Rows (one per result):
   - `<title> | <employer> | <location> | <qualification_band> | <url>`
2. Summary:
   - `scanned=<n> valid=<n> deduped=<n> rejected=<n>`
3. If no valid result:
   - `TOOL_FAILED`
4. After first 50 in high-volume/nonstop flows, ask exactly:
   - `Continue options: [1] next 50 [2] continuous until stop`

Do not claim success without at least one verified vacancy URL.
If returning `TOOL_FAILED`, return only `TOOL_FAILED` with no extra text.

## Artifact contract (CSV/PDF)

When the user requests CSV/PDF:

1. Build CSV content from verified rows and save with `write`.
2. Save under `/home/node/.openclaw/exports/apprenticeship-hunter/`:
   - `ranked.csv`
   - `ranked.pdf` (if PDF conversion tool is unavailable, save a plain-text `.pdf` placeholder is not allowed; return `TOOL_FAILED` instead).
3. In the user reply, include the result rows and absolute artifact paths.

## Staged continuation mode

When the user asks for nonstop/high-volume hunting:

1. First run: execute a single batch with `maxResults=50` and present results.
2. Immediately ask continuation choice:
   - `Continue options: [1] next 50 [2] continuous until stop`
3. If user chooses `next 50`, run again with:
   - `maxResults=50`
   - `excludeUrls=<URLs from previous delivered rows>`
4. If user chooses `continuous until stop`, start recurring runs at `cadence_minutes`.
5. Continue recurring until the user sends the exact stop phrase.
6. On stop, confirm:
   - `HUNT_STOPPED`

## Example user prompts this skill should handle

- "Find live retail apprenticeships in Birmingham within 25km and keep hunting until I say stop."
- "Run a nonstop UK retail apprenticeship hunt for Warwickshire and report every 30 minutes."
- "Stop UK retail hunt now."
