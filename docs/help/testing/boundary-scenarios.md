---
summary: "Request, paid-work, recovery, default, and measurement proof contracts"
title: "Behavioral proof scenarios"
read_when:
  - You are changing provider requests, paid work, recovery, or defaults
  - You are making cache, billing, or performance claims
---

## Scenario contracts

Use focused integration tests through production owners with fixed external I/O
fixtures. Keep independent unit contracts. Apply the
[test value gate](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md)
and [proof policy](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-testing/SKILL.md#proof-policy).

- Name the caller-visible contract, credible regression, and proof limits. Use
  independent expected values and the caller's interface. Exact bytes, storage,
  call counts, and ordering belong when they protect storage, billing, delivery,
  or protocol contracts.
- Work in vertical slices: failing behavior, coherent repair, passing proof.
  A regression must fail on the original defect, not fixture setup; report
  unavailable baseline proof. Refactor under green tests; check distinct
  contracts before replacing redundant tests.
- Capture final serialized requests and resolved routing after real assembly:
  instructions, tools/order, input prefix, parameters, cache identity, endpoint,
  and auth mode. Warm-prefix reuse shares one preparation owner; document
  permitted differences. Standalone summaries need an intentional contract.
- Keep a paid provider result or never request it. Preflight predictable failures
  before calling. Distinguish not sent, uncertain, completed, and persisted;
  reconcile uncertainty. Exactly-once claims need proof retries cannot duplicate
  effects. Inject relevant failures and assert physical requests/usage, including
  rejected results. Local processing errors must not silently buy another call;
  preserve valid results without bypassing redaction, cancellation, or authority.
- Prove recovery through its diagnostic consumer with a sanitized reason/outcome.
  Warn on unexpected degradation; expected recovery may use a documented
  structured outcome. Persist replay decisions, reconstruct, and exercise the
  next request. Cover relevant compaction, switching, and concurrent edits;
  transient errors must not become permanent bans.
- Exercise defaults across affected routes, auth modes, capabilities, and stored
  states through execution's eligibility owner. Cover supported and unsupported
  cases, not copied capability tables or precomputed flags.
- Support cost/performance claims with comparable request counts, input/cached/
  output tokens, and latency; name model, route, and conditions. Live cache or
  billing claims need live evidence; label estimates. Unrelated edits do not
  require paid benchmarks.

Use synthetic content; keep credentials out of captures. Select failure cases
from the changed contract. Many private controls suggest fragmented ownership,
not a need for more test-only exports.

## SecretRef registry regression contract

When extending SecretRef registry coverage, preserve this authoring requirement:

- `src/secrets/exec-secret-ref-id-parity.test.ts` should derive one sampled target
  per SecretRef class from registry metadata (`listSecretTargetRegistryEntries()`),
  then assert traversal-segment exec ids are rejected.
- If you add a new `includeInPlan` SecretRef target family in
  `src/secrets/target-registry-data.ts`, update `classifyTargetClass` in that test.
  The guardrail must fail on unclassified target ids so new classes cannot be
  skipped silently.

The current parity test covers shared exec-id vectors but no longer contains the
registry sampler or `classifyTargetClass`; restore that coverage when extending
registry families rather than assuming the vector checks cover registry traversal.
