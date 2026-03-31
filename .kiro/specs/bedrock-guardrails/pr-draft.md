## Summary

- Problem: The amazon-bedrock plugin has no way to apply AWS Bedrock Guardrails (content filtering, PII blocking, topic denial, sensitive information filters, contextual grounding) to model invocations. Operators who need external content policy enforcement on Bedrock models have no config surface for it.
- Why it matters: Bedrock Guardrails provide strong, externally managed content safety enforcement — PII redaction, topic blocking, word filters, and grounding checks — without modifying prompts or application code. This is critical for enterprise and compliance-sensitive deployments.
- What changed: Extended the `amazon-bedrock` plugin config schema with an optional `guardrail` object (`guardrailIdentifier`, `guardrailVersion`, optional `streamProcessingMode`). Added a `createGuardrailWrapStreamFn` factory that injects `guardrailConfig` into the Bedrock `ConverseStreamCommand` payload via `streamWithPayloadPatch`/`onPayload`. Updated `docs/providers/bedrock.md` with configuration and IAM guidance.
- What did NOT change (scope boundary): No changes to pi-ai, no changes to core `src/`, no changes to other extensions. The guardrail injection composes around the existing Anthropic/non-Anthropic cache behavior — that logic is untouched.

## Change Type (select all)

- [ ] Bug fix
- [x] Feature
- [ ] Refactor required for the fix
- [x] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #TBD
- Related: N/A
- [ ] This PR fixes a bug or regression

## Root Cause / Regression History (if applicable)

N/A — new feature.

## Regression Test Plan (if applicable)

N/A — new feature, no regression. New test coverage added:

- Coverage level:
  - [x] Unit test
  - [ ] Seam / integration test
  - [ ] End-to-end test
  - [ ] Existing coverage already sufficient
- Target test or file: `extensions/amazon-bedrock/index.test.ts`
- Scenario the test should lock in: Guardrail config round-trips into payload correctly; absent config means no injection; cache behavior preserved for both Anthropic and non-Anthropic models.
- Why this is the smallest reliable guardrail: Unit tests on the wrapper factory and payload patch cover the full injection surface without needing live AWS credentials.
- If no new test is added, why not: N/A — tests are added.

## User-visible / Behavior Changes

- New optional plugin config: `guardrail` object under the `amazon-bedrock` plugin config with `guardrailIdentifier` (string, required), `guardrailVersion` (string, required), and `streamProcessingMode` (optional, `"sync"` or `"async"`).
- When configured, all Bedrock model invocations include `guardrailConfig` in the Converse API payload.
- No behavior change when `guardrail` is omitted (default).
- New IAM permission needed when using guardrails: `bedrock:ApplyGuardrail`.

## Diagram (if applicable)

```text
Before:
[agent request] -> [wrapStreamFn: cache behavior] -> [ConverseStreamCommand]

After:
[agent request] -> [guardrail wrapper] -> [wrapStreamFn: cache behavior] -> [streamWithPayloadPatch: inject guardrailConfig] -> [ConverseStreamCommand]
```

## Security Impact (required)

- New permissions/capabilities? Yes — `bedrock:ApplyGuardrail` IAM permission required when guardrails are configured. This is an opt-in feature; no new permissions needed when guardrails are not configured.
- Secrets/tokens handling changed? No
- New/changed network calls? No — the same Bedrock ConverseStream endpoint is called, just with an additional `guardrailConfig` field in the request body.
- Command/tool execution surface changed? No
- Data access scope changed? No
- Risk + mitigation: The guardrail identifier and version are user-provided config values injected into the API payload. They are validated by the JSON Schema (required strings) and by the Bedrock API itself. No code execution or injection risk.

## Repro + Verification

### Environment

- OS: Any (Node 22+)
- Runtime/container: Node.js / Bun
- Model/provider: amazon-bedrock (any Bedrock model)
- Integration/channel (if any): N/A
- Relevant config (redacted):
```json5
{
  // In plugin config for amazon-bedrock:
  "guardrail": {
    "guardrailIdentifier": "your-guardrail-id-or-arn",
    "guardrailVersion": "1",
    "streamProcessingMode": "sync"  // optional
  }
}
```

### Steps

1. Configure a Bedrock Guardrail in your AWS account (content filter, PII filter, etc.)
2. Add the `guardrail` config to the amazon-bedrock plugin config with the guardrail ID and version
3. Send a message through OpenClaw using a Bedrock model
4. Observe that the Bedrock API request includes `guardrailConfig` and the guardrail policies are applied

### Expected

- Bedrock API requests include `guardrailConfig` with the configured identifier and version
- Content that violates the guardrail policies is filtered/blocked by Bedrock
- When `guardrail` config is omitted, behavior is identical to before this change

### Actual

- Confirmed via Docker-based manual testing with STS-assumed role, application inference profile (`arn:aws:bedrock:us-east-1:723944466306:application-inference-profile/osaqrgj6cj55`), and guardrail ID `3i5e0gco0f5w` (DRAFT version).

## Evidence

Attach at least one:

- [x] Failing test/log before + passing after
- [x] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

Manual testing results (Docker, STS creds, inference profile, guardrail `3i5e0gco0f5w` DRAFT):

| Test | Scenario                         | Result                                                                                 |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | Happy path (benign message)      | "Paris is the capital of France." — guardrail allowed                                  |
| 2    | Guardrail blocks (topic denial)  | "Sorry, your query violates our usage policy." — guardrail blocked                     |
| 3    | Trace enabled                    | Normal response with trace config accepted                                             |
| 4    | No guardrail config (regression) | `AccessDeniedException` — IAM deny enforcement rejected call without `guardrailConfig` |
| 5    | Required fields only             | Normal response, no errors about missing optional fields                               |
| 6    | Full ARN as guardrailIdentifier  | Normal response, same behavior as plain ID                                             |
| 7    | Invalid guardrail ID             | `"The provided guardrail identifier is invalid."` — clean AWS error, no local crash    |
| 8    | Async stream processing mode     | Normal response with async guardrail evaluation                                        |

## Human Verification (required)

- Verified scenarios: All 8 test scenarios from the manual testing guide (happy path, guardrail block, trace, no-guardrail regression, required-fields-only, full ARN, invalid ID, async mode)
- Edge cases checked: Invalid guardrail ID (AWS error), missing guardrail config with IAM deny enforcement (AccessDeniedException), full ARN vs plain ID, DRAFT version
- What you did **not** verify: `enabled_full` trace mode, production (non-DRAFT) guardrail versions, non-Anthropic models with guardrails (tested with Sonnet 4.6 inference profile only)

## Review Conversations

- [ ] I replied to or resolved every bot review conversation I addressed in this PR.
- [ ] I left unresolved only the conversations that still need reviewer or maintainer judgment.

## Compatibility / Migration

- Backward compatible? Yes — the `guardrail` config is optional. Omitting it preserves existing behavior exactly.
- Config/env changes? Yes — new optional `guardrail` object in the amazon-bedrock plugin config.
- Migration needed? No
- If yes, exact upgrade steps: N/A

## Risks and Mitigations

- Risk: Users configure an invalid guardrail ID/version and get Bedrock API errors.
  - Mitigation: The Bedrock API returns clear error messages for invalid guardrail references. No special handling needed — errors surface through the existing pi-ai stream error path.
- Risk: Users lack the `bedrock:ApplyGuardrail` IAM permission.
  - Mitigation: Documented in `docs/providers/bedrock.md`. The Bedrock API returns a clear permissions error.

## AI Assistance Disclosure

- [x] This PR was AI-assisted (Kiro)
- [x] Lightly tested — unit tests written, manual Bedrock verification TBD
- [x] I understand what the code does
