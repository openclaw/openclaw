# Page triage with a Decision model

Use `browser` action `judge` to identify page blockers before extracting content.
This is explicit advisory inference, not an automatic navigation consumer. It
works with text-capable Chromium and Lightpanda profiles; it is not native
Lightpanda `page.judge()`.

## Preconditions

- Keep the authorized tab and its exact profile/location. A judgment describes
  only that observation, not a later navigation or DOM update.
- Use the action only when the Browser tool advertises `judge`. It requires the
  calling agent's bound Decision runtime. The selected Decision model must
  support text and Boolean questions; configuration does not establish service
  health or credentials.
- Page evidence goes to the selected provider, which may be hosted and charge
  for inference. Only use content authorized for that destination. A local
  browser does not imply local inference.
- Existing-session profiles do not support the required text reader. Inspect
  those pages with ordinary `snapshot`; do not silently select another profile,
  browser, model, or inference endpoint.

## Judge the current tab

Replace the tab and profile with the values already selected for the task. Keep
any explicit `target`/`node` for remote execution.

```json
{ "action": "judge", "targetId": "task", "profile": "openclaw" }
```

The action reads up to 6,000 characters from `body`, adds the existing untrusted
content wrapper, and makes one evaluation through the agent's selected Decision
provider. `body` retains consent prompts outside `article` or `main`. The
primary model receives the judgment, not the page excerpt. No arbitrary page
extraction model, browser-owned credential, Python process, or second browser
session is created.

The response includes `targetId`, `url`, `observation` (`chars`, `truncated`),
and `judgment`. A successful evaluation preserves the Decision result's model,
answers, reported probabilities, optional confidence, usage, and provenance.
The fixed questions cover `loading`, `empty_results`, `login_wall`,
`consent_wall`, `bot_challenge`, `paywall`, `error_page`, and
`unsupported_browser`. Multiple blockers can coexist.

An unavailable provider remains `judgment.status="unavailable"` with its original
reason. Empty page text returns `empty-observation` without invoking a model.
Caller cancellation remains cancellation, not a negative judgment or a retry.

## Interpret without taking automatic action

- `judgment.status="ok"` means inference completed, **not** that the page is usable.
  Preserve explicit Boolean answers, nulls, per-question errors, missing values,
  probabilities, and provider-reported confidence. Never invent explanations or
  calibrated accuracy from these values.
- All-low scores do not prove usable content. Blank pages, iframe-only blockers,
  partial observations, truncation, and borderline or contradictory answers
  need ordinary inspection.
- Loading is not empty results. If loading is plausible, use one bounded wait
  for an observable page state and then take fresh evidence. If unresolved,
  report uncertainty rather than repeatedly classifying.
- Do not ingest a login form, CAPTCHA, error page, or paywall as requested
  content. Skip only when the task permits it. Login, payment, CAPTCHA, and
  consent changes retain normal authorization/manual-action requirements. A
  consent-wall judgment is never permission to click Accept cookies.
- Failure does not initiate a fallback. Ordinary browser inspection remains
  available; do not automatically retry, switch models, or send a larger page.

## Native Lightpanda compatibility

OpenClaw's adapter keeps its existing CDP page. Upstream experimental Python
`page.judge()` uses MCP `classify`, which owns a different browser session.
The released Lightpanda 1.0.2 has no native classification operation. Do not
probe guessed CDP methods or reopen an authenticated URL through MCP. See the
[Lightpanda guide](https://docs.openclaw.ai/tools/browser/lightweight#page-classification-and-judge)
for pinned source evidence and the native-integration prerequisite.
