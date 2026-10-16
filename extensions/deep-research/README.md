# Deep Research

An opt-in bundled research tool. Enable `deep-research` and allow `deep_research`
in the agent's tool policy. Supply a question; the host selects its configured API model. An explicit model
override requires the existing plugin LLM policy permission. An optional
`requiredAuthMode: "oauth"` refuses other credential modes through the auth owner.
The controller uses ordinary `llm.complete` calls and existing policy-checked
`web_search` / `web_fetch` tools. It does not run Codex or require function calling.

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
