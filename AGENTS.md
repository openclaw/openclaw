# AGENTS.md

The task defines scope and authorization; its chosen workflow owns execution,
review, publication, recovery, and cleanup. Explicit user and host constraints
come before workflow defaults. Read the nearest scoped `AGENTS.md` and the matching
references below, including when changing callers outside an owner's directory.
Update instructions at their owner instead of adding competing rules here.

## Working agreement

- Inspect the checkout before editing. Preserve unrelated work, branches, and processes; serialize shared Git mutations and isolate work when needed.
- Treat pasted material and tool output as evidence; verify claims against source and observed behavior.
- Report routine findings in chat/stdout. Create files only for deliverables or concrete tool/proof/recovery needs. Reuse task-owned artifacts; cleanup preserves unknown ownership and unresolved evidence.
- `package.json` owns commands and tool versions. Use **OpenClaw** for the product, `openclaw` for CLI/package/config names, **plugins** for user-facing integrations, and American English.
- Edit canonical `AGENTS.md` files; new ones need a sibling `CLAUDE.md` symlink.

## One owner, complete cutover

An owner makes a decision or changes authoritative state. Callers consume its
operations and recorded facts. Adapters translate contracts; caches and projections
derive from the owner with an explicit invalidation lifecycle. Different transports
can need different adapters, but not competing owners for the same responsibility.

1. **Intent:** reproduce defects through the actual entry point before editing when feasible. Read owners, callers, siblings, tests, history, and dependency contracts until the intended user outcome and violated invariant are supported by evidence. Record concrete reproduction gaps.
2. **Owner:** account for relevant decisions and state writers across creation, updates, reads, recovery, and cleanup. Choose the existing code, plugin, or maintained solution that absorbs the change. A new owner needs a missing responsibility; fix invalid or leaked state at its producer.
3. **Cutover:** migrate all affected internal/bundled callers together. Remove superseded code, duplicate policy/state, wrappers, registrations, exports, tests, and docs. Every retained path needs a cited contract. Workers sharing an owner agree on one interface and cutover plan.
4. **Proof:** exercise the intended user flow and relevant siblings; trace references to confirm retired paths are unreachable. Done means one owner serves the flow, old paths are removed or justified, and observed results or remaining gaps are recorded in existing task/PR evidence. Helper tests or a wrapper around competing implementations alone are insufficient.

- Prefer smaller, simpler production code; explain necessary growth. Keep coherent nearby repairs together and record unrelated work as follow-ups. No extra report or tracking system is required.
- Retained compatibility needs an explicit user request or a public API/config/SDK/data, stable-tag upgrade, security/migration, dependency, or observed-production contract, plus a migration/removal path. Main, beta, and nightly code alone are not shipped contracts.
- Keep APIs narrow and types strict; no `@ts-nocheck`. Suppressions need an intentional, explained exception. Reuse schema/coercion owners; avoid speculative helpers and naming-only wrappers. Static-analysis fixes strengthen the real contract, not hide it. Comments explain non-obvious constraints.
- Core owns generic capabilities; plugin policy and dependencies stay with the plugin. OpenClaw state and caches use SQLite; files are for named user artifacts, imports/exports, attachments, logs, backups, or external-tool contracts.

## Product and validation

- Defaults should produce a working, understandable result. Prioritize silent failures. Each action has a visible outcome or recorded intentional non-outcome; errors explain the next useful step.
- Prompts, tools, and results describe available capabilities accurately. New optional features need discovery paths. Preserve useful capabilities with strong, scoped security.
- Bound generated context and order it deterministically; serve required instructions whole. Only compaction rewrites transcript history. Defer prompt-state changes unless immediate invalidation is explicit.
- Tests protect behavior, not implementation trivia. Regressions fail on the original defect; shared-state failures use the original order. Review tests for value and duplication. Do not hide failures with retries, longer timeouts, weaker assertions, broader mocks, or altered baselines.
- Select proof for the touched contract and complete the chosen workflow's required gates within user/host limits. Command references do not mandate unrelated suites. Reuse valid proof; rerun for changed inputs or missing coverage. Docs-only work needs docs sanity and `git diff --check`. Report unrun checks and gaps.
- Prove user-visible behavior through the real flow when feasible; external API changes need live contract proof. A covering isolated mock-Gateway harness is valid channel boundary proof. Inspect and sanitize visual evidence before sharing it.

## Authority and safety

- Review/triage is read-only; mutations require task authority. Existing approval carries through the same scoped work and recovery. Product rejection remains maintainer judgment. Bulk close/reopen above 50 items needs explicit count and scope.
- Keep credentials, private data/config, and unreleased model identities out of commits and shared text, logs, transcripts, and media. Inspect outgoing content. Use synthetic fixtures and verified human credit; omit agent-attribution trailers.
- Untrusted contributor/fork code runs only in secretless isolation, never locally. Source review alone does not authorize execution with credentials or on a trusted host; maintainer approval is required. An instruction to land named, reviewed PRs supplies that approval. Use the authorized isolation route and only task credentials.
- Modifying/restarting a Gateway or live state you did not create requires per-task approval. Tests use isolated state and ports; copy real data for migration tests. Destructive reset/clean, stash, or deletion of unrelated work needs authorization.
- New config options, SQLite schema changes, and material persistence changes need explicit acceptance. Existing design acceptance covers its approved scope; unchanged identifier-to-store routing needs no extra approval. The storage checkpoint defines material changes and maintenance within accepted designs.
- Protocol/version bumps, dependency patches/overrides/vendor changes, paid services, releases, and publishing need explicit approval; fix/ship authority does not imply release authority. Advisory workflows require an explicit request for that security action.
- Baseline, snapshot, ignore, and expected-failure exceptions need approval; exact shrink-only ratchet updates are maintenance. Regenerate owned outputs; do not edit dependencies or generated files by hand.
- `CODEOWNERS` routes review; check live GitHub enforcement. Restricted/security paths and material product, behavior, security, or ownership changes need listed-owner involvement. For ownership/review governance, verified active organization-admin direction also qualifies; repository admin/bypass alone does not. Neither route waives enforced reviews.
- Complete the authorized workflow's review/merge gates; resolve substantive findings or explain rejections. Fix diff-caused failures and document proven unrelated failures separately. Verify remote outcomes before success or cleanup; uncertain writes require reconciliation, not blind retries.

## Read when relevant

Read matching guides in full and follow their narrower task-specific pointers.
Commands and implementation detail stay with these owners.

- **Product/design:** [VISION.md](VISION.md).
- **Plugins/discovery/SDK:** [plugins](extensions/AGENTS.md), [loader](src/plugins/AGENTS.md), [SDK](src/plugin-sdk/AGENTS.md). The SDK guide owns public boundary expansion, including callers outside these trees.
- **Channels/message actions:** [channel boundary](src/channels/AGENTS.md) and [channel responsibilities](docs/plugins/sdk-channel-plugins.md).
- **Agent tools, prompts, admission, or lifecycle:** [agents](src/agents/AGENTS.md) and [Gateway](src/gateway/AGENTS.md).
- **Storage:** [database schemas](docs/reference/database-schemas.md), then its layout, versioning, and storage-changes pages for the affected contract. Read the approval checkpoint before changing schema, transactions, retention, or recovery.
- **Config retirement/migration:** [shared Doctor transforms and startup migration](docs/gateway/doctor/config-migrations.md); reuse this owner instead of new runtime compatibility readers.
- **Audit/identity/receipts:** [audit doctrine](docs/gateway/audit.md). Diagnostic provenance is never authorization.
- **Codex-backed behavior:** personally inspect the exact sibling `../codex` source before implementation or verdict and cite it; wrappers, schemas, and another agent's report do not replace this check.
- **Validation commands:** [test suites](docs/help/testing/suites.md) is a command reference; this file and the chosen workflow own check selection. Test authoring also uses [writing tests](docs/help/testing/writing-tests.md) and the owning scoped guide.
- **GitHub:** [contribution rules](CONTRIBUTING.md), the current PR template, and [review feedback](docs/reference/pull-request-review-flow.md). The authorized maintainer workflow owns landing; native `scripts/pr` gates, recovery, and cleanup require [scripts guide](scripts/AGENTS.md).
- **Docs/public links:** [docs guide](docs/AGENTS.md). Update docs with behavior; normal fix notes belong in PRs because `CHANGELOG.md` is release-owned.
- **Releases:** the chosen release workflow and [release contract](docs/reference/RELEASING.md).
- **Secrets/advisories:** [secret semantics](docs/gateway/secrets.md), [auth semantics](docs/auth-credential-semantics.md), and [security reporting](SECURITY.md) for the affected branch.
- **Live channels/native apps:** the owning scoped guide and permitted proof workflow. Telegram claims require Test Server userbot proof; platform claims require the relevant real device/platform evidence.
