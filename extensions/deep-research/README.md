# Deep Research

A default-enabled, lazy bundled research tool. Existing plugin allowlists and tool policy still apply. Disable it with `plugins.entries.deep-research.enabled: false`.
Supply a question; the host selects its configured model and isolated agent runtime.
An explicit model override requires the existing plugin LLM policy permission.
The controller uses `llm.complete` with `execution.mode: "isolated-agent-runtime"`
and existing policy-checked `web_search` / `web_fetch` tools. A selected Codex
runtime executes bounded native turns, not a managed research service. Unsupported
native routes produce an explicit partial result; there is no direct fallback.
The optional `requiredAuthMode: "oauth"` retains the host's explicit direct-only
completion contract and refuses other credential modes. It is never dropped to
force native execution. Results report the actual returned runtime and owner;
`unobserved` means no completion supplied runtime evidence. Hosted search uses
the originating session's selected model/profile when its provider matches,
independently of a research-only model override. Search URLs are discovery only;
source evidence still requires a separate fetch.

The result contains source text, content fingerprints, quote-linked findings,
reported token usage, and explicit gaps. Failed branches, invalid citations, no
evidence, cancellation, and exhausted budgets cannot produce a complete result.
Source restrictions select accepted evidence; they are not a network firewall.
Findings pass exact-quote integrity checks and a separate, fallible model support/contradiction audit. Derived numbers carry a mechanically checked input/value/unit/date ledger. Model quality is not guaranteed.

Supplied documents disable public search by default; set `sources.web: true` explicitly for mixed research. URLs supplied explicitly may still be fetched. The retained corpus is capped at 60,000 UTF-8 bytes. Output is a structured Markdown report; `output` specifies its requested focus, not an arbitrary output encoder.

All branches share bounded model/search/fetch call admission and a deadline.
Token totals are observational, not a hard token or dollar budget. The feature never chooses a fallback provider or account. The host may rotate
its configured eligible auth profiles; use an authorized `model@profile` override
to pin one credential owner. Retrieved source text is untrusted.

## Control UI

The session header's **Deep research** action opens the native research pane. It
lists only this conversation incarnation's retained jobs; reopening a job never
starts another run. The pane shows real recorded phases and observed counts,
sources as they are retained, and the available completed or partial report.
Cancel remains **requested** until the execution owner observes a terminal state.
Paused jobs offer Resume only when the existing accepted-source recovery owner can
reauthorize them. Unknown submissions are indeterminate and never blindly retried.

The plugin owns `deep-research.view.v1.{list,read,start,cancel,resume}`. All methods
use authenticated Gateway session access with the `deep_research` tool policy;
all methods require operator.write because the current native session gate admits
only write-scoped handlers. List/read remain pure local reads. Selectors
are not grants: the admitted target supplies agent, session and incarnation. An
opaque incarnation fence includes lifecycleRevision, including replacements that
retain sessionId. Browser acceptance keys are scoped to that incarnation.
Mutations require the opaque incarnation returned by an authenticated list; the
server compares this selector with its admitted target before accepting any effect.
An old mounted pane cannot start work in a replacement conversation.
List/read inspect only bounded local keyed state and never run recovery or poll a
provider. Start promptly returns a durable, idempotent acceptance for the existing
service-owned wake, not a detached model call. The original authenticated source
must support recoverable work. A repeated key with different input is rejected.
The read model is version 1, with a content revision, timestamps and explicit
allowed actions. Unknown counts are absent, not invented zeros.

The empty `plugin.deep-research.changed` broadcast is a coalesced invalidation,
never a private job/event payload. Views reauthorize on invalidation, session
change and reconnect. A still-mounted offline client labels retained data stale and disables writes.
The native host retires plugin activation on disconnect, clears the pane body, and shows its
unavailable-panel state. Reconnect remounts and reauthorizes retained jobs without resubmission;
access failures clear the view. Pending starts retain their exact key and question
in tab-scoped session storage until acknowledgement or incarnation/access change,
so an uncertain response can be reconciled without duplicate work. Transient read
failures quarantine the pending request until the same admitted incarnation is
confirmed; only proven pre-acceptance rejections unlock a fresh start.

Portable citations are emitted by the report composer as `reportCitations`;
`startByte` is inclusive and `endByte` exclusive in the exact report's UTF-8 bytes,
not UTF-16 character indices. The view maps each to a stable source ID. Managed
citations without valid ranges appear as provider-cited source entries, not
invented inline citations. Provider attribution remains distinct from fetched or
supplied text. Quote matching is mechanical; model-supported evidence is fallible.
The pane renders report/source content as text (no raw HTML, remote images or
previews). Only credential-free HTTP(S) source links can open externally. Citation
buttons focus the matching source detail and return focus to the report citation.
