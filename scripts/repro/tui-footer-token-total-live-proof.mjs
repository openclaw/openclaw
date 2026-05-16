#!/usr/bin/env node
/**
 * Live repro for TUI footer token total when usage counters are missing (#43009).
 * Run: pnpm exec tsx scripts/repro/tui-footer-token-total-live-proof.mjs
 */
import { formatTokens, resolveSessionFooterTokenTotal } from "../../src/tui/tui-formatters.ts";

const contextTokens = 200_000;

const cases = [
  {
    label: "context only (was ?/200k in footer)",
    session: { contextTokens },
  },
  {
    label: "explicit total",
    session: { totalTokens: 42_000, contextTokens },
  },
  {
    label: "input + output fallback",
    session: { inputTokens: 10_000, outputTokens: 5_000, contextTokens },
  },
];

for (const { label, session } of cases) {
  const total = resolveSessionFooterTokenTotal(session);
  console.log(`${label}: ${formatTokens(total, contextTokens)}`);
}
