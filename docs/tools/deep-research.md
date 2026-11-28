---
summary: "Run multi-source research with cited findings, explicit evidence gaps, and optional Google managed research"
title: "Deep Research"
read_when:
  - Researching a question across web sources or supplied documents
  - Comparing sources and checking for conflicting claims or evidence gaps
  - Configuring Google managed research or portable research budgets
---

Deep Research lets your agent investigate a question across multiple web sources
or documents you supply, then return a structured Markdown report with inline
citations, exact supporting quotes, and explicit evidence gaps. It ships as a
bundled, default-enabled plugin (`deep_research`), so you can ask for deep
research in chat right away without extra setup.

## What Deep Research does

Instead of answering from a single search snippet, Deep Research plans
sub-questions, searches and fetches source pages (or reads documents you
provide), checks each finding against exact quotes in the retrieved text, and
reports what could not be verified.

You can use it in two modes:

- **`portable` (default):** Works with any model and web search/fetch setup you
  already have configured. It checks exact quotes mechanically, audits support
  and contradictions with a separate model pass, and verifies derived arithmetic
  (sums, differences, ratios, percent changes) against cited values, units, and
  dates.
- **`google` (opt-in):** Routes research to Google's managed Deep Research
  Interactions service (`deep-research-preview-04-2026`) when you explicitly
  enable it with a pinned Google API-key profile.

## How to use it

Because Deep Research is enabled by default, just ask your agent in chat when
you want a cited, multi-source investigation. Existing plugin allowlists and
agent tool policy still apply.

Practical prompts:

- **Web comparison:** _"Run deep research comparing the 2026 river restoration
  totals across state and federal reports, and call out any conflicting numbers."_
- **Domain-scoped check:** _"Use deep research to summarize OpenClaw's latest
  release notes, restricting sources to `docs.openclaw.ai` and `github.com`."_
- **Local document synthesis:** _"Run deep research over these three vendor
  proposals I'm pasting below and highlight unresolved pricing gaps."_ (When you
  supply documents, public web search stays off unless you ask to mix in web
  sources.)
- **Specific time frame or focus:** _"Do deep research as of 2026 on EU AI Act
  compliance deadlines for small teams, formatted as an executive summary with
  open questions."_

Disable the plugin at any time with
`plugins.entries.deep-research.enabled: false`. On an empty startup, the plugin
does not resolve research credentials or make research network requests; it only
scans bounded local job state and reconstructs due wakes.

## What you get

Every completed or partial job returns a structured report and durable job state:

- **Cited findings and exact quotes:** Portable findings require exact,
  substantive quotations from the retained source text, plus a separate model
  support and contradiction check so conflicting sources are surfaced rather than
  glossed over.
- **Explicit evidence gaps:** Missing data, inaccessible URLs, malformed model
  responses, or exhausted budgets produce a partial report with an **Unresolved**
  section instead of silent guesses.
- **Restart resilience:** Active jobs, operation receipts, and pending
  cancellations persist in the plugin state store. Eligible jobs recover and
  reconcile automatically after a Gateway restart without blindly resubmitting
  unknown requests.
- **7-day retention:** Jobs, receipts, and saved reports stay available for seven
  days (up to 32 retained jobs per conversation), and repeated reads return the
  exact same stored report.

## Choose an engine

| Engine               | Execution                                                   | Evidence                                                           | Configuration                                             |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `portable` (default) | Ordinary API completions plus configured search/fetch tools | Retrieved text, exact quotations, fallible model support audit     | Existing model and web-tool configuration                 |
| `google`             | Google's managed Deep Research Interactions service         | Provider-attributed report citations; not locally fetched passages | Explicit research enablement and a pinned API-key profile |

The portable engine does not require Codex, native function calling, or a
vendor-specific agent. Foreground and recovered completions use the originating
agent's configured model and normal credential resolution. Model overrides obey
existing plugin LLM policy. Recovery does not restore unrecorded session-specific
model or auth-profile overrides.
`requiredAuthMode: "oauth"` requires that mode through the existing auth owner;
it never silently falls back to an API key. This feature does not implement a
Codex research RPC or a private ChatGPT OAuth client. Codex API-key, Codex OAuth,
and ChatGPT plan-usage/token-sharing qualification are separate.

## Start and inspect research

Call the `deep_research` tool with a stable idempotency key for one request:

```json
{
  "action": "start",
  "idempotencyKey": "river-report-1",
  "request": {
    "question": "Compare the reported river restoration totals.",
    "engine": "portable",
    "asOf": "2026",
    "output": "A concise comparison with unresolved differences",
    "sources": { "urls": ["https://example.org/report"] },
    "budget": { "modelCalls": 8, "searches": 6, "fetches": 12, "parallelism": 2 }
  }
}
```

Keep the returned `jobId`. Subsequent calls use
`{ "action": "status" | "result" | "resume" | "cancel", "jobId": "..." }`.
`{ "action": "capabilities" }` reports the portable route and the explicitly
activated managed adapter; availability is not a live entitlement check.

A repeated start with the same key returns the existing job without resubmitting.
Changing the request under that key is rejected. Results are returned as tool
responses; the plugin never sends a separate channel message. Repeated result
reads return the same saved report, so there is no independently retried delivery.

## Portable evidence and budgets

All exploration branches share the model/search/fetch counters. Defaults are
8 model calls, 6 searches, 12 fetches, 2 parallel fetches, and a 180-second global
deadline starting when an execution slot is admitted. Maximums are 30, 20, 40, 4, and 900 seconds. Each model response requests
at most 4,096 output tokens. Token totals are observed, not a hard token or dollar
cap. Search and fetch use the originating session's normal tool policy.

Use `sources.allowDomains` / `denyDomains` to select accepted evidence.
Denied domains take precedence. These are evidence filters, not a network
firewall: search and redirect transports retain their own network policies.
Duplicate source text counts once. The retained corpus is limited to 60,000
UTF-8 bytes; omitted or unreadable material is reported as a gap.

Supply `sources.documents: [{ "title": "...", "text": "..." }]` for local-text
research. Documents disable public search by default; explicitly set
`sources.web: true` for mixed research. Explicit URLs may still be fetched.

Findings require substantive exact quotations and a separate model support/
contradiction check. Derived values additionally require mechanically checked
inputs, units, dates, and arithmetic. These checks do not establish truth or
completeness. Missing evidence, malformed model responses, inaccessible sources,
and exhausted budgets produce partial results with explicit gaps.

## Google managed research

Configure an existing Google API-key auth profile. No new auth store is used.

```json5
{
  plugins: {
    entries: {
      google: {
        config: {
          research: { enabled: true, profileId: "google:research" },
        },
      },
    },
  },
}
```

Then start with `request.engine: "google"`. The provider uses the documented
Gemini Interactions API and `deep-research-preview-04-2026`, with background
execution, storage enabled, web search and URL context. API billing and provider
storage apply. The provider binds each interaction to its originating agent,
conversation incarnation, and selected API-key profile/account. Foreign sessions,
reset or deleted incarnations, and changed credentials are rejected before native
read or cancellation. The binding survives process restart; it does not grant
authority to whoever possesses the handle.

Google research rejects supplied documents/URLs, local source restrictions,
model/auth overrides, and local duration/call/search/token budgets. Use portable research
when those controls are required. Each managed invocation performs one bounded
reconciliation step, then returns a running remote job as paused. The service
owns the next authorized poll and its persisted backoff. There is no foreground
polling loop. Managed research rejects `durationMs` because it cannot control
the provider's runtime or spend.

## Recovery and cancellation

One feature service owns job, wake, cancellation, and report-publication state in
the existing plugin state store. Jobs and operation receipts expire after seven
days; each conversation retains at most 32 jobs. A bounded index holds up to
4,096 lightweight wake references, not report bodies. Startup reconstructs persisted due
work. Overlapping wakes coalesce, and stored terminal results are not republished.
Obsolete wake references are removed atomically without deleting a newer job
or wake. Non-retryable poll errors defer automatic reconciliation immediately.
Temporary host-authority refresh, unexpected execution/transport failures, initial
adapter-preparation refusals, and retryable, definitively not-sent starts share
persisted backoff and defer after
five failures over the job lifetime; each retry acquires fresh authority.
Retryable poll failures use persisted exponential backoff and defer after five
consecutive failures; a successful poll clears the failure count. The native
handle remains available for inspection or an explicitly authorized resume. If the
plugin state store itself cannot be read or updated, the persisted wake survives
but recovery may require restarting the service after storage is restored.

Before accepting a job, the host records its original admitted source separately
from plugin data. Each wake revalidates that source's current identity, grants,
model restrictions, conversation incarnation, sharing, and tool policy. Saved
targets and native handles are not authorization. Sources without recoverable
authority, revoked access, or changed session policy leave a precise unavailable
or deferred state; they do not acquire system privileges or switch accounts.

Known managed receipts are polled automatically, including pending cancellation.
Portable work reuses completed operation receipts and the original deadline;
after expiry it renders available evidence into a partial report without new
model/search/fetch calls. Queued jobs have a `jobId` before an execution slot opens.
Reset, deletion, service retirement, and provider retirement fence late effects
and report publication. `status`, `result`, and an explicit authorized `resume`
remain available; ordinary recoverable jobs do not require another tool invocation.

An interrupted operation without a recorded receipt is not automatically
repeated. A managed submission with no recoverable remote handle is
`indeterminate`; inspect the provider account instead of starting it again.
Do not create a new idempotency key as an automatic retry for such a job.
A still-live service can retain proof that dispatch was never attempted or that
the provider/router definitively refused a start. Temporary session refresh,
startup, or pairing refusals then use bounded automatic backoff; permanent policy
refusals defer for an explicit authorized resume. This bookkeeping retains no
report content or execution permission. Unclassified RPC failures, timeouts, and
crashes without that durable proof do not establish that a submission was never sent.

Cancellation intent is persisted before stopping local work. Once a managed start
is admitted, cancellation waits for its receipt and then cancels that handle; it
does not discard the receipt by aborting the local request. If only the feature's parent tool signal stops and the host transport still
returns a receipt, the feature records it while service and conversation authority
remain valid, then schedules reconciliation under fresh host authority. Host-scoped cancellation
is not bypassed: it can abort the RPC and lose the receipt even when the feature's
own signal argument remains active. Such transport loss, service shutdown, or
actual authority retirement can leave an indeterminate submission. If the provider
owner retires or the state write fails before the interaction binding is committed,
a returned interaction ID alone cannot authorize recovery or cancellation through
the tool. Do not resubmit; inspect the original provider account directly. This
receipt-before-binding window is not solved by automatic recovery. Managed cancellation
is confirmed only by a terminal provider response; an HTTP success or aborted
local request does not prove the remote job stopped. Pending cancellation survives
service stop/start and is reconciled by the next authorized wake. Provider completion can win the cancellation race;
the observed final state is returned honestly.

## Qualification

Deterministic tests cover the controller, evidence ledger, registered provider
transport, recovery, and cancellation. They do not establish live provider
access, cancellation latency, billing, retention compliance, or research quality.
No native-service or OAuth live qualification is implied. See
[Research adapters](/plugins/research-adapters) for the versioned provider contract.
