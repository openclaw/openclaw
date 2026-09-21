# AGENTS.md

The task defines scope and authorization; its chosen workflow owns execution,
review, publication, recovery, and cleanup. Explicit user instructions take
precedence over skill guidelines and workflow defaults; host limits and required
authorization boundaries still apply. Read the nearest scoped `AGENTS.md` and the
matching references below, including when changing callers outside an owner's directory.
Update instructions at their owner instead of adding competing rules here.

## Design priorities

- **One owner per responsibility.** An owner makes a decision or changes authoritative state. Callers consume its operations and recorded facts. Adapters translate contracts; caches and projections derive from the owner with an explicit invalidation lifecycle. Different transports can need different adapters, but not competing owners for the same responsibility.
- **Small core, capable plugins.** Model-facing core additions have an ongoing context cost. Optional capability belongs at the edges; core supplies generic contracts. A feature needing a new integration is not, by itself, a reason to add another core tool or manager. [VISION.md](VISION.md) owns product scope.
- **Stable conversation context.** Rebuilding past context defeats prompt-prefix reuse. Keep generated prompt/tool/context additions bounded and deterministic, preserve transcript bytes, and serve required instructions whole. Only compaction rewrites history. Defer changes to stable prompt state until the next session unless its owner defines explicit invalidation; preserve existing skill, tool, and memory refresh contracts.

## Working agreement

- Follow through on actionable requests, including "can you", within their authorized scope. When execution is requested, a plan or progress report is a checkpoint, not completion. Use prior context and preserve unaffected work across corrections and side questions.
- Resolve routine, reversible choices with reasonable assumptions. Ask only about consequential decisions the request and context cannot resolve; continue independent authorized work while waiting. Silence does not authorize a gated action.
- If a skill causes a pause, permission request, unfinished work, or scope change, link its exact `SKILL.md` and quote the instruction to the user. Explain how it applies, distinguish requirements from interpretation, and check prior authorization before asking again.
- Inspect `git status -sb` before editing or GitHub work. Preserve unrelated work, branches, processes, and user-managed checkouts; serialize shared Git mutations and isolate work when needed. Never switch a checkout while another agent or test run uses it.
- Treat pasted material and tool output as evidence; verify claims against source and observed behavior.
- Lead with the result and follow the user's format. Use plain words, active voice, and useful technical detail; omit stock phrases and repeated summaries. Reference each PR/issue once per reply. Auto-links count; don't repeat the URL. Progress updates explain new findings, decisions, or blockers. Keep delegated messages equally clear.
- Report routine findings in chat/stdout. Create files only for deliverables or concrete tool/proof/recovery needs; state their purpose and reuse them. Cleanup removes only task-created disposable files that are no longer needed or in use. Preserve unknown ownership, required evidence, and recovery state; this does not authorize existing-storage cleanup or retention changes.
- Read relevant docs before changing behavior; `pnpm docs:list` locates them. `package.json` owns current commands and versions; keep the repository's toolchain and conventions rather than swapping tools without approval.
- Use **OpenClaw** for the product, `openclaw` for CLI/package/config names, **plugins** for user-facing integrations, and American English.
- Edit canonical `AGENTS.md` files directly.

## Execution discipline

- Root cause deep. Proof scoped.
- Real failing entry point first. Bypassed boundary != proof.
- Separate product bugs from tool/fixture failures.
- Check relevant prerequisites early. Parallelize independent work.
- New check needs named unknown, risk, or required gate. Reuse valid proof.
- Repeated failures or 10 min without new evidence: change approach. No blind retries.
- Behavior proven + required gates green: finish/land. No optional proof polish or speculative scope growth.
- Time pressure never waives gates. Report concrete blockers.
- Visual change: inspected before/after screenshots. Behavior-only fix: direct boundary proof. No checkbox demos.

## One owner, complete cutover

1. **Intent:** reproduce defects through the actual entry point before editing when feasible. Read complete affected modules, owners, callers, siblings, tests, history, and dependency contracts until the intended user outcome and violated invariant are supported by evidence. Before restoring a missing path, check why it was removed (`git log -p -S <symbol>`): isolation may be intentional, and a retired alias may be a completed migration. Record concrete reproduction gaps.
2. **Owner:** account for relevant decisions and state writers across creation, updates, reads, recovery, and cleanup. Choose the existing code, plugin, or maintained solution that absorbs the change. A new owner needs a missing responsibility; fix invalid or leaked state at its producer.
3. **Cutover:** migrate all affected internal/bundled callers together. Remove superseded code, duplicate policy/state, wrappers, registrations, exports, tests, and docs. Every retained path needs a cited contract. Workers sharing an owner agree on one interface and cutover plan.
4. **Proof:** exercise the intended user flow and relevant siblings; trace references to confirm retired paths are unreachable. Done means one owner serves the flow, old paths are removed or justified, and observed results or remaining gaps are recorded in existing task/PR evidence. Helper tests or a wrapper around competing implementations alone are insufficient.

- Prefer smaller, simpler production code; explain necessary growth. Keep coherent nearby repairs together and record unrelated work as follow-ups. No extra report or tracking system is required.
- Delegate independent evidence or implementation lanes when parallel work reduces time or improves verification. Give each lane a clear responsibility and completion condition; keep simple or tightly coupled work with the lead. The lead stays hands-on, verifies consequential conclusions, and coordinates shared-checkout safety.
- Retained compatibility needs an explicit user request or a public API/config/SDK/data, stable-tag upgrade, security/migration, dependency, or observed-production contract, plus a migration/removal path. Main, beta, and nightly code alone are not shipped contracts.

### Choose the capability surface

For new capability, use the first path that expresses the actual requirement:

1. Extend the existing owner or use an existing command, skill, plugin, or supported integration.
2. Use an existing plugin contract. Prefer bundle plugins for skills, MCP servers, and configuration; use code plugins when runtime hooks, providers, channels, or tools are needed. Keep vendor behavior with its vendor plugin and feature behavior with its feature owner.
3. If the contract is missing, define a narrow generic core/SDK capability and move existing bundled implementations and callers onto it together. Repeated independent requests for the same capability trigger this contract review, not another parallel manager or hook.
4. Add universal core surface only when the need is fundamental and existing extension points cannot express it. Explain the gap and ongoing cost; a new hook needs a concrete consumer.

For example, a new channel action should first use the shared message action
contract. A setup screen needing plugin metadata should use the manifest or
lightweight artifact, not load the plugin's execution runtime.

## Runtime and code safeguards

- Plugins use documented `openclaw/plugin-sdk/*` contracts, manifest metadata, and public/local barrels, never core internals or another plugin's private files. Dependencies follow runtime ownership.
- Runtime consumes canonical config/state. Doctor/migration owners normalize legacy shapes; plugin repairs stay plugin-owned. A change invalidating existing config includes its matching migration. Startup may invoke the same approved Doctor transforms; do not add independent compatibility readers.
- OpenClaw state and caches use SQLite, not new JSON/JSONL/sidecar stores. Files are for named user artifacts, imports/exports, attachments, logs, backups, or external-tool contracts.
- Use Kysely for ordinary SQLite access; raw SQL is limited to schema, migrations, bootstrap, and justified primitives. Write transactions are synchronous: finish asynchronous planning first, then reread authoritative rows before writing. No Promise or `await` in a transaction callback.
- Database access runs in worker threads, never on the Gateway main thread: readers use the read-only worker scope, writers the SQLite worker broker, and the main thread only awaits results and installs published facts. Boot admission, migrations, Doctor/CLI one-shots, and lock primitives are the only synchronous exceptions. Existing synchronous main-thread access is legacy: never add more, and migrate any such path you touch.
- Privileged actions require current owner-held authority. Revalidate after awaited work and immediately before side effects; tokens, signatures, expiry, and matching IDs alone do not prove live authority.
- Core owns shared message tools, action vocabulary, and dispatch. Channels own their account, security, conversation, and transport contracts. Preserve typed command/approval/URL/action distinctions until encoding; never infer product commands from raw strings.
- Carry prepared facts through hot paths. Reuse process-stable plugin metadata and lifecycle-owned caches; do not repeatedly load registries or freshness-poll files. Preserve lazy module boundaries and verify relevant builds on the authorized host.
- Keep APIs narrow, valid states explicit, and TypeScript ESM/types strict. Prefer real types or `unknown`; no `@ts-nocheck`. Suppressions need an intentional, explained exception. Reuse schema/coercion owners; avoid duplicate guards, speculative helpers, and naming-only wrappers.
- Static-analysis fixes strengthen the real type/runtime contract or remove the unsafe operation; do not conceal it with casts, widening, marker types, or property probes. New lint rules need a meaningful invariant and a clean owner scope.
- Comments explain non-obvious ownership, lifecycle, ordering, cleanup, platform, and dependency constraints, not syntax. Do not edit `node_modules` or generated artifacts by hand, or change formatter settings for a local expression; regenerate owned outputs.

## Product and validation

- Defaults should produce a working, understandable result. Prioritize silent failures. Each action has a visible outcome or recorded intentional non-outcome; errors explain the next useful step.
- **Updates always work.** `openclaw update` finishes best effort on every install. Any change touching update, Doctor, service lifecycle, config/state migration, or plugin loading states its update behavior: the installed updater runs first and cannot be patched, so candidate-side fixes key on markers shipped drivers already set, and existing operator state is the input. Recoverable hiccups become recorded warnings; back up before mutating and let rollback restore it; refuse only for concrete data at risk, naming the reason and leaving the previous Gateway running. Timeouts and budgets are generous, derived from measured state, and sized for old, slow hardware. Proof: a published-driver × candidate cell.
- Prompts, tools, and results describe available capabilities accurately and give enough context for the next useful action; avoid unnecessary model round trips. Inject cross-tool references from the enabled tool set and remove stale model-facing arguments instead of hidden compatibility. New optional features need discovery paths.
- Security is a product tradeoff, not a goal to maximize restrictions. Weigh concrete risk and likely impact against user effort, lockouts, and lost capability. Prefer the least restrictive effective safeguard; bounded, understood risk can be acceptable for a substantial usability benefit. Keep risky paths explicit and operator-controlled within the existing trust model and approval boundaries, and explain the tradeoff instead of inventing extra gates.
- Tests must protect meaningful behavior; skip tests for reversible, low-impact changes that merely mirror the implementation. Regressions fail on the original defect; shared-state failures use the original order. Review tests for value and duplication.
- Treat test failures as defects and make a bounded, best-effort attempt to reproduce them (same shard order first), identify their cause, and fix the owning fixture, shared state, ordering, or product. When a safe fix is established, add a regression and document the cause; cite another owner's fix when applicable. If reasonable investigation cannot establish or complete a safe fix, record the original failure, attempted reproductions, evidence, and remaining uncertainty in the PR, then continue under the normal CI and review gates. The unresolved failure alone must not block landing or trigger an extra approval request. Never claim a passing replay proves a fix. Do not rerun, re-push, or refresh merely to get green, or conceal failures with retries, longer timeouts, weaker assertions, broader mocks, or altered baselines.
- **Red `main` is an emergency, not a queue item.** When `main` is broken, fix it in a fresh worktree, prove it with the exact failing check plus the focused tests (locally or on a Testbox), and push the fix straight to `main` when your permissions allow, so every open PR unblocks at once; open a PR only if the push is refused, and say so. Reruns do not clear a red `main`, and PRs whose merge ref went red need a fresh push after the fix lands.
- Every test spends CI time on every PR. New or changed tests state their measured cost in the PR (`pnpm test <file> --maxWorkers=1` wall, and CI seconds once the run exists) and stay within the budgets in [writing tests](docs/help/testing/writing-tests.md): no real timers, sleeps, or polling; no per-test Gateway or process boots when a suite-level fixture exists; no new serial config or worker pin; no broad barrel imports. A test that needs seconds must prove a contract that no cheaper layer can, and long end-to-end compositions belong in the release-only tier, not per-PR CI.
- Select proof for the touched contract and complete the chosen workflow's required gates within user/host limits. Command references do not mandate unrelated suites. Reuse valid proof; rerun for changed inputs or missing coverage. Docs-only work needs docs sanity and `git diff --check`. Report unrun checks and gaps.
- Prove user-visible behavior through the real flow when feasible; external API changes need live contract proof. A covering isolated mock-Gateway harness is valid channel boundary proof; live channel proof is stronger. State concrete capture or execution blockers.
- **Visual screenshot completion/landing gate:** For changes to visual appearance or rendered UI states, attach inspected, sanitized before/after screenshots in the originating chat AND upload/embed them in the GitHub PR body or a PR comment linked from its body. Successful chat attachment delivery satisfies the chat requirement; do not verify rendering in the user's browser, ask the user to confirm visibility, or block landing because the agent cannot inspect the chat. Verify that the PR images render before merging or claiming completion. Local files, private inspection, chat-only delivery, logs, tests, review approval, and artifact-manifest links are not substitutes. Galleries and videos supplement, never replace, the required screenshots. Known attachment or upload failures remain delivery blockers; repair them or report the blocker. Only an explicit user waiver can exempt a destination.
- Before committing or landing nontrivial code, obtain fresh review through the permitted workflow and resolve actionable findings unless the user opts out. Tests protect observable contracts; a helper test can pass while the registered entry point never calls it.

### Execution gotchas

These commands apply on the host permitted by the task and its workflow; they do
not authorize local execution or a broader test plan.

- Restore missing dependencies in a trusted normal checkout with `pnpm install`, then retry once before diagnosing a code defect. Never reconcile a shared/worktree install while other jobs use it.
- Run the CLI through `pnpm openclaw ...` or `pnpm dev`, never `node --import tsx src/index.ts`; the supported wrappers own build freshness and process setup.
- Use installed `oxfmt` for formatting and the repository's `tsgo` lanes for typechecking. Inspect scope with `pnpm changed:lanes --json`; use targeted tests/checks. When avoiding worktree reconciliation, use `node scripts/check-changed.mjs` or `node scripts/run-vitest.mjs` with ready dependencies. Host restrictions still apply.

## Authority and safety

- Review/triage is read-only; mutations require task authority. Existing approval carries through the same scoped work and recovery. When new approval is required, complete the already-authorized preparation first and present a concrete, reviewable result; pause only the gated action. Product rejection remains maintainer judgment. Bulk close/reopen above 50 items needs explicit count and scope.
- Keep credentials, private data/config, and unreleased model identities out of commits and shared text, logs, transcripts, and media. Inspect outgoing content. Use synthetic fixtures and verified human credit; omit agent-attribution trailers.
- For permitted defensive work interrupted by a cyber classifier, use an approved, available Daybreak Blue route only for that bounded task, then restore the previous model. Preserve the approved identity, scope, permissions, sandbox, and review gates. Never switch models to bypass access denials, disallowed requests, or refused tool actions; if that route also refuses, stop and report. Follow [OpenAI's guidance](https://learn.chatgpt.com/docs/cyber-safety) for approved model access.
- Untrusted contributor/fork code runs only in secretless isolation, never locally. Source review alone does not authorize execution with credentials or on a trusted host; maintainer approval is required. An instruction to land named, reviewed PRs supplies that approval. Use the authorized isolation route and only task credentials.
- Modifying/restarting a Gateway or live state you did not create requires per-task approval. Tests use isolated state and ports; copy real data for migration tests. Destructive reset/clean, stash, or deletion of unrelated work needs authorization.
- Updating `team.openclaw.ai` must only happen by negotiating with Night Watch on `stable.openclaw.ai`, never directly.
- Explicit repair-and-land authority includes internal scheduling, database admission, and lifecycle implementation decisions. The agent owns design selection, risk assessment, and verification; do not request renewed approval for implementation decisions within that scope.
- Bug fixes within the authorized task do not need renewed approval, including compatible SDK changes needed to restore intended behavior. Ask again for new configuration options, breaking public contracts, intentional changes to schemas, durability, retention, or permissions beyond the bug fix, paid services, or destructive actions. Preserve FIFO ordering, live-authority and integrity checks, and settlement of write-capable work.
- Protocol/version bumps, dependency patches/overrides/vendor changes, paid services, releases, and publishing need explicit approval; fix/ship authority does not imply release authority. Advisory workflows require an explicit request for that security action.
- Extended-stable is one line: the trailing completed month relative to `main`'s version. Older `.33+` lines retire when `main` advances another month; publishing a retired line needs an explicit maintainer decision, not a routine guard bypass.
- Baseline, snapshot, ignore, and expected-failure exceptions need approval, except narrow scanner qualifications for verified synthetic test fixtures. Agents may add these within the authorized task without asking when matching is bound to exact fixture bytes and source location, scanning and verification stay enabled, and proof rejects changed inputs. Broad suppressions and uncertain or real credentials still require approval. Exact shrink-only ratchet updates are maintenance.
- `CODEOWNERS` routes review; check live GitHub enforcement. Restricted/security paths and material product, behavior, security, or ownership changes need listed-owner involvement. For ownership/review governance, verified active organization-admin direction also qualifies; repository admin/bypass alone does not. Neither route waives enforced reviews.
- Complete the authorized workflow's review/merge gates; resolve substantive findings or explain rejections. Address failures under the best-effort test-failure policy above; distinguish proven unrelated failures from unexplained ones and cite an owning fix when known. Verify remote outcomes before success or cleanup; uncertain writes require reconciliation, not blind retries.
- Stage only intended files and use concise Conventional Commits with verified author/writer identities. Preserve contributor credit; team-session credit requires consented, verified humans and its canonical backlink. A bare URL grants no public mutation authority. Keep PR bodies current with problem, solution, impact, and evidence; use body files/heredocs for shell-sensitive text.

## Read when relevant

Read matching guides in full and follow their narrower task-specific pointers.
Commands and implementation detail stay with these owners.

- **Product/design:** [VISION.md](VISION.md).
- **Plugins/discovery/SDK:** [plugins](extensions/AGENTS.md), [loader](src/plugins/AGENTS.md), [SDK](src/plugin-sdk/AGENTS.md). The SDK guide owns public boundary expansion, including callers outside these trees.
- **Channels/message actions:** [channel boundary](src/channels/AGENTS.md) and [channel responsibilities](docs/plugins/sdk-channel-plugins.md).
- **Agent tools, prompts, admission, or lifecycle:** [agents](src/agents/AGENTS.md) and [Gateway](src/gateway/AGENTS.md).
- **Control UI state, requests, or presentation:** [UI guide](ui/AGENTS.md), including state shared with other Gateway clients.
- **Storage:** [database schemas](docs/reference/database-schemas.md), then its layout, versioning, and storage-changes pages for the affected contract. Read the approval checkpoint before changing schema, transactions, retention, or recovery.
- **Config retirement/migration:** [shared Doctor transforms and startup migration](docs/gateway/doctor/config-migrations.md); reuse this owner instead of new runtime compatibility readers.
- **Audit/identity/receipts:** [audit doctrine](docs/gateway/audit.md). Diagnostic provenance is opt-in and never authorization; changes to collection, reader scope, retained fields, bounds, or contracts require approval.
- **Codex-backed behavior:** personally inspect the exact sibling `../codex` source before implementation or verdict and cite it; wrappers, schemas, and another agent's report do not replace this check. Auth/runtime/catalog routes use `openai`; legacy `openai-codex` input belongs only in migration. Harness upgrades refresh [the harness guide](docs/plugins/codex-harness.md) from `model/list`.
- **Validation commands:** [test suites](docs/help/testing/suites.md) is a command reference; this file and the chosen workflow own check selection. Test authoring also uses [writing tests](docs/help/testing/writing-tests.md) and the owning scoped guide.
- **GitHub:** [contribution rules](CONTRIBUTING.md), the current PR template, and [review feedback](docs/reference/pull-request-review-flow.md). The authorized maintainer workflow owns landing; native `scripts/pr` gates, recovery, and cleanup require [scripts guide](scripts/AGENTS.md).
- **Docs/public links:** [docs guide](docs/AGENTS.md). Update docs with behavior; normal fix notes belong in PRs because `CHANGELOG.md` is release-owned.
- **Releases:** the chosen release workflow and [release contract](docs/reference/RELEASING.md). Preserve the selected release cut and identity through publication and verification. npm-format lock mirrors are verified against `pnpm-lock.yaml`, published in dependency evidence, and kept out of npm tarballs.
- **Secrets/advisories:** [secret semantics](docs/gateway/secrets.md), [auth semantics](docs/auth-credential-semantics.md), and [security reporting](SECURITY.md) for the affected branch.
- **Live channels/native apps:** the owning scoped guide and permitted proof workflow. Telegram claims require Test Server userbot proof with Convex-leased credentials; platform claims require the relevant real device/platform evidence. Mac permission proof needs a stable, properly signed app; see [signing](docs/platforms/mac/signing.md).
