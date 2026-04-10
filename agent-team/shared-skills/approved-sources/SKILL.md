---
name: approved_sources
description: Check that every cited source is on the team allowlist and not on the denylist before posting. Trigger on any outbound message that cites a publication, feed, or webpage.
---

# Approved Sources

The team uses a strict source allowlist and a short denylist. Every citation must come from the allowlist. Reuters is explicitly denied.

## Trigger

About to cite a source in a Slack post, a research file, a brief, or a stress test.

## Allowlist (primary)

- **SEC EDGAR** (10-K, 10-Q, 8-K, S-1, proxy) — preferred for any financial fact about a US-listed company.
- **Company Investor Relations pages** — earnings releases, transcripts, guidance.
- **Federal Reserve** (FOMC statements, minutes, SEPs, H.4.1, H.8).
- **BLS** (CPI, PPI, NFP, JOLTS).
- **BEA** (GDP, PCE).
- **Treasury Direct** (auction results, TIC data).

## Allowlist (market news + research)

- **The Wall Street Journal**
- **The New York Times**
- **Bloomberg** (terminal excerpts, bloomberg.com)
- **Financial Times**
- **mktnews.com**

## Denylist

- **Reuters** — marked unreliable by the operator. Do not cite, do not link, do not quote.

## Steps

1. Identify the publication / feed / page you are about to cite.
2. Confirm it matches an allowlist entry. If it is a wire service or aggregator, trace it back to the underlying allowlist source and cite that instead.
3. If you cannot find it on the allowlist and it is not obviously a primary source (e.g. a company press release on the company's own domain), do NOT cite it. Escalate to `@Orchestrator - Portfolio Manager` in `#agents` with the URL and a one-line "can we add this?" — Orchestrator decides.
4. Confirm it is not on the denylist. If it is, find a different source or drop the claim.

## Evaluating a new source (decision tree)

- Is it a primary source (issuer, regulator, central bank, statistical agency)? → Propose for allowlist.
- Is it a paywalled publication of record with an editorial standards page? → Propose for allowlist.
- Is it an aggregator republishing other reporting? → Find the original and cite that.
- Is it a blog, substack, tweet, or Telegram channel? → Do not cite. May be used as a lead but never as a citation.

## Output format

This skill decorates the source line inside `source_and_confidence`. Nothing else to emit.

## Next step

Return to the skill that triggered this one and continue posting.
