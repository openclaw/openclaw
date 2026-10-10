# AGENTS.md

## Choose good compromises

Every design trades correctness against complexity and performance. Pick the compromise deliberately; never maximize one axis at the others' expense.

- Design for failures that actually happen: crashes, restarts, retries, real concurrent writers, reported incidents. Do not engineer for millisecond races, theoretical interleavings, or adversarial timing unless they put user data, security, or money at risk, or a real incident shows them.
- Prefer the cheap mechanism: idempotency keys, one check at the point of effect, retry, best-effort recording with a warning. Fencing tokens, revocation generations, multi-phase admission, nonce-matched settlement, and per-write cross-thread handshakes need a concrete failure that simpler code cannot handle.
- Name the accepted edge case in a comment or the PR instead of coding around it. A rare, visible, recoverable glitch beats permanent complexity.
- Complexity is a correctness risk too: machinery nobody can follow fails in ways nobody predicted.

The task defines scope and authorization; its chosen workflow owns execution,
review, publication, recovery, and cleanup. Explicit user instructions take
precedence over skill guidelines and workflow defaults; host limits and required
authorization boundaries still apply. Read the nearest scoped `AGENTS.md` and the
matching references below, including when changing callers outside an owner's directory.
Update instructions at their owner instead of adding competing rules here.

## Design priorities

- **One owner per responsibility.** An owner makes a decision or changes authoritative state; callers consume its operations and recorded facts. Adapters translate contracts; caches and projections derive from the owner with an explicit invalidation lifecycle. Transports may need different adapters, never competing owners.
- **Small core, capable plugins.** Model-facing core additions have an ongoing context cost. Optional capability belongs at the edges; core supplies generic contracts. A new integration alone is no reason for another core tool or manager. New capability takes the first fitting step of the [capability ladder](src/plugin-sdk/AGENTS.md#choose-the-capability-surface): existing owner, existing plugin contract, narrow generic core/SDK capability, then universal core surface. [VISION.md](VISION.md) owns product scope.
- **Stable conversation context.** Rebuilding past context defeats prompt-prefix reuse. Keep generated prompt/tool/context additions bounded and deterministic, preserve transcript bytes, and serve required instructions whole; only compaction rewrites history. Defer stable-prompt changes to the next session unless the owner defines explicit invalidation; keep existing skill, tool, and memory refresh contracts. A side request reusing a conversation shares the turn's request preparation or carries no cache identity.

## Working agreement

- Follow through on actionable requests, including "can you", within authorized scope; a plan or progress report is a checkpoint, not completion. Preserve unaffected work across corrections and side questions.
- Resolve routine, reversible choices with reasonable assumptions; ask only about consequential decisions context cannot resolve, and continue independent authorized work meanwhile. Silence does not authorize a gated action.
- If a skill causes a pause, permission request, unfinished work, or scope change, link its exact `SKILL.md`, quote the instruction, explain how it applies (requirement vs interpretation), and check prior authorization before asking again.
- Inspect `git status -sb` before editing or GitHub work. Preserve unrelated work, branches, processes, and user-managed checkouts; serialize shared Git mutations and isolate work when needed; never switch a checkout another agent or test run uses.
- Treat pasted material and tool output as evidence; verify against source and observed behavior.
- Lead with the result in the user's format: plain, active, technically useful; no stock phrases or repeated summaries. Reference each PR/issue once per reply. Progress updates explain new findings, decisions, or blockers.
- Report findings in chat; create files only for deliverables or tool/proof/recovery needs, stating their purpose and reusing them. After verified completion, remove task-owned proof, scratch, and finished worktrees per [closeout](.agents/skills/openclaw-pr-maintainer/SKILL.md#finalize-and-clean-up), preserving deliverables, live and unknown owners, unfinished state, and credentials.
- Read relevant docs before changing behavior (`pnpm docs:list`); `package.json` owns commands and versions; tool swaps need approval.
- Use **OpenClaw** (product), `openclaw` (CLI/package/config), **plugins** (user-facing integrations), and American English. Edit canonical `AGENTS.md` files directly.

## Execution discipline

- Root cause deep. Proof scoped.
- Real failing entry point first. Bypassed boundary != proof.
- Separate product bugs from tool/fixture failures.
- Check relevant prerequisites early. Parallelize independent work.
- New check needs named unknown, risk, or required gate. Reuse valid proof.
- Two identical tooling failures without new evidence, or 10 min without progress: switch to an authorized supported alternative with the reviewed head pinned; reconcile uncertain writes first. No blind retries or guard bypasses.
- Behavior proven + required gates green: finish/land. No optional proof polish or speculative scope growth.
- Check mergeability first; don't rebase or merge `main` just because it advanced. Integrate for conflicts, a named failing gate, or material base risk, then rerun affected checks. Prior-head CI stays prior-head evidence; admin exceptions belong to the native landing workflow ([landing](.agents/skills/openclaw-pr-maintainer/references/landing.md)).
- Time pressure never waives gates. Report concrete blockers.
- Visual change: inspected before/after screenshots. Behavior-only fix: direct boundary proof. No checkbox demos.

## One owner, complete cutover

1. **Intent:** reproduce defects through the actual entry point before editing when feasible. Read complete affected modules, owners, callers, siblings, tests, history, and dependency contracts until the intended outcome and violated invariant are evidenced. Before restoring a missing path, check why it was removed (`git log -p -S <symbol>`); isolation may be intentional, a retired alias a completed migration.
2. **Owner:** account for decisions and state writers across creation, updates, reads, recovery, and cleanup. Choose the existing code, plugin, or maintained solution that absorbs the change; a new owner needs a missing responsibility. Fix invalid or leaked state at its producer.
3. **Cutover:** migrate all affected internal/bundled callers together; remove superseded code, duplicate policy/state, wrappers, registrations, exports, tests, and docs. Retained paths need a cited contract; workers sharing an owner agree on one interface and plan.
4. **Proof:** exercise the user flow and relevant siblings; trace references to confirm retired paths are unreachable. Done = one owner serves the flow, old paths removed or justified, results or gaps recorded in task/PR evidence. Helper tests or wrappers around competing implementations are insufficient.

- Prefer smaller, simpler production code; explain necessary growth. Keep coherent nearby repairs together; record unrelated work as follow-ups.
- Delegate independent lanes when that saves time or improves verification, each with a clear responsibility and completion condition; keep simple or tightly coupled work with the lead, who stays hands-on, verifies consequential conclusions, and owns shared-checkout safety.
- Retained compatibility needs an explicit user request or a public API/config/SDK/data, stable-tag upgrade, security/migration, dependency, or observed-production contract, plus a migration/removal path. Main, beta, and nightly code are not shipped contracts.

## Runtime and code safeguards

- Plugins use documented `openclaw/plugin-sdk/*` contracts, manifest metadata, and public/local barrels, never core internals or another plugin's private files. Dependencies follow runtime ownership.
- Runtime consumes canonical config/state; Doctor/migration owners normalize legacy shapes (plugin repairs stay plugin-owned), and config-invalidating changes ship their migration.
- State and caches use SQLite, not new JSON/JSONL/sidecar stores; files are for named user artifacts, imports/exports, attachments, logs, backups, or external-tool contracts.
- Kysely for ordinary SQLite; raw SQL only for schema, migrations, bootstrap, and justified primitives. Write transactions are synchronous: plan async work first, reread authoritative rows, then write; no Promise or `await` in transaction callbacks.
- Database access runs in worker threads (read-only worker scope, SQLite writer broker), never on the Gateway main thread, which only awaits results and installs published facts. Exceptions: boot admission, migrations, Doctor/CLI one-shots, lock primitives. Existing main-thread access is legacy: never add more; migrate what you touch.
- SQLite format, schema-version, integrity, canonical-index, and table-existence checks run once per physical database per process load, shared with all workers and handles. This includes quarantine-store format; existing indexed durable quarantine-row guards still observe recorded corruption. Reuse admitted format facts across opens, scopes, requests, and idle close; identify replacement files by volume, inode, and birthtime with `fstat`, not SQL. Migration/repair owners publish new facts after their DDL; Doctor and explicit verification retain their checks. Never add repeated format checks; remove them when touched.
- The Gateway process owns every OpenClaw database and its state. In-process writer receipts invalidate cached rows across workers and handles; use direct reads when a cache cannot be covered. Never add runtime foreign-commit probes (`PRAGMA data_version`, version observations, or foreign-observation scopes); remove them when touched. Outside writers, including CLI, Doctor, cron, and plugin children, must use the Gateway or hold exclusive ownership while it is stopped. Preserve live-authority checks at effect boundaries and consistent snapshots for multi-statement reads. See [database schemas](docs/reference/database-schemas.md).
- Security boundaries (credentials, approvals, tool and command execution, external side effects) need current owner-held authority: revalidate after awaited work and right before the effect. Tokens, signatures, expiry, and matching IDs alone do not prove live authority. Internal bookkeeping (scheduling, receipts, history, caches) uses idempotency and a check at the effect instead.
- Core owns shared message tools, action vocabulary, and dispatch; channels own account, security, conversation, and transport contracts. Keep typed command/approval/URL/action distinctions until encoding; never infer commands from raw strings.
- Carry prepared facts through hot paths; reuse process-stable plugin metadata and lifecycle-owned caches; never repeatedly load registries or freshness-poll files. Preserve lazy module boundaries and verify relevant builds on the authorized host.
- Narrow APIs, explicit valid states, strict ESM/types. Real types or `unknown`; no `@ts-nocheck`; suppressions need an explained exception. Reuse schema/coercion owners; no duplicate guards, speculative helpers, or naming-only wrappers.
- Static-analysis fixes strengthen the real contract or remove the unsafe operation, never hide it with casts, widening, marker types, or property probes. New lint rules need a real invariant and clean owner scope.
- Comments explain non-obvious ownership, lifecycle, ordering, cleanup, platform, and dependency constraints, not syntax. Regenerate generated outputs; never hand-edit them or `node_modules`, or tweak formatter settings per expression.

## Product and validation

- Defaults produce a working, understandable result. Prioritize silent failures: every action has a visible outcome or recorded intentional non-outcome; errors name the next step.
- **Updates always work** (`openclaw update` finishes best effort everywhere). Changes to update, Doctor, service lifecycle, migrations, or plugin loading state their update behavior. The installed updater runs first and can't be patched, so candidate fixes key on markers shipped drivers set; existing operator state is the input. Recoverable hiccups become recorded warnings; back up before mutating and let rollback restore it; refuse only for named data risk with the previous Gateway kept running. Timeouts and budgets are generous, derived from measured state, and sized for slow hardware. Proof: a published-driver × candidate cell.
- Prompts, tools, and results describe available capabilities accurately, with context for the next useful action and no unnecessary model round trips; inject cross-tool references from the enabled tool set, drop stale model-facing arguments, and give new optional features discovery paths.
- Security is a product tradeoff: weigh concrete risk against user effort, lockouts, and lost capability; prefer the least restrictive effective safeguard, keep risky paths explicit and operator-controlled within the existing trust model and approval boundaries, and explain tradeoffs instead of inventing gates.
- **Behavior over test count.** Prefer production-path integration proof and independent unit contracts. Before changing provider requests, fallbacks, recovery, or defaults, and when writing or reviewing behavioral tests, read [boundary proof](docs/help/testing/writing-tests.md#prove-behavior-at-the-owning-boundary).
- Test failures are defects: reproduce, fix the owner with a regression, or record evidence and continue (unresolved alone doesn't block landing). Never mask failures or claim a passing replay proves a fix ([policy](.agents/skills/openclaw-testing/SKILL.md#test-failure-policy)).
- **Red `main` is an emergency; CI is expensive.** Push proven red-`main` fixes directly to `main`; prove changes locally or on Testbox, never rerun or re-push just for green; inherited-only reds land via the native admin exception, named in the PR ([policy](.agents/skills/openclaw-pr-maintainer/references/landing.md#red-main-and-inherited-failures)).
- New/changed tests follow the [writing tests](docs/help/testing/writing-tests.md) cost budget: PRs state `pnpm test <file> --maxWorkers=1` wall time and CI seconds; no real timers, sleeps, polling, per-test Gateway/process boots when a suite-level fixture exists, new serial config or worker pins, or broad barrel imports. Seconds-long tests must prove a contract no cheaper layer can; long end-to-end compositions go to the release-only tier.
- Select proof for the touched contract, reuse valid proof (rerun for changed inputs or missing coverage), and finish the workflow's required gates within user/host limits; report unrun checks and gaps. Prove user-visible behavior through the real flow when feasible; external APIs need live contract proof; an isolated mock-Gateway harness is valid channel boundary proof. Docs-only: docs sanity and `git diff --check`.
- **Visual changes** need inspected, sanitized before/after screenshots in chat and embedded in the PR before merge or completion ([gate](.agents/skills/openclaw-pr-maintainer/references/media.md#screenshot-completion-gate)).
- Before committing or landing nontrivial code, get fresh review through the permitted workflow and resolve actionable findings unless the user opts out. Actionable means likely or high-impact: decline unlikely, recoverable edge cases whose fix adds disproportionate complexity, with a one-line reason.

### Execution gotchas

Run the CLI via `pnpm openclaw ...` or `pnpm dev`, never `node --import tsx src/index.ts`, and never reconcile a shared/worktree install other jobs use. Dependency, vendoring, format, and typecheck gotchas: [scripts guide](scripts/AGENTS.md#execution-gotchas).

## Authority and safety

- Review/triage is read-only; mutations need task authority. Approval carries through the same scoped work and recovery; for new approval, complete authorized preparation, present a concrete reviewable result, and pause only the gated action. Product rejection is maintainer judgment. Bulk close/reopen above 50 items needs explicit count and scope.
- Keep credentials, private data/config, and unreleased model identities out of commits, shared text, logs, transcripts, and media; inspect outgoing content. Synthetic fixtures, verified human credit, no agent-attribution trailers.
- Never switch models to bypass refusals; cyber-classifier interruptions of permitted defensive work follow [security triage](.agents/skills/security-triage/SKILL.md#cyber-classifier-interruptions).
- Untrusted contributor/fork code runs only in secretless isolation, never locally; credentialed or trusted-host execution needs maintainer approval, which an instruction to land named, reviewed PRs supplies (isolation route, task credentials only).
- Modifying/restarting a Gateway or live state you did not create needs per-task approval. Tests use isolated state and ports; copy real data for migration tests. Destructive reset/clean, stash, or deleting unrelated work needs authorization.
- Updating `team.openclaw.ai` must only happen by negotiating with Night Watch on `stable.openclaw.ai`, never directly.
- Repair-and-land authority covers internal scheduling, database admission, and lifecycle design, risk, and verification; in-task bug fixes (including compatible SDK fixes) and backed-up repairs that remove only invalid or unreachable data need no renewed approval. Ask again for new config options, breaking public contracts, intentional schema/durability/retention/permission changes beyond the bug fix, paid services, or destructive actions. Preserve FIFO ordering, live-authority/integrity checks, and write-capable work settlement.
- Protocol/version bumps, dependency patches/overrides/vendoring, paid services, releases, and publishing need explicit approval; fix/ship authority is not release authority. Advisory workflows need an explicit security request.
- Extended-stable is one line, the trailing completed month relative to `main`'s version; older `.33+` lines retire when `main` advances a month, and publishing a retired line needs an explicit maintainer decision, not a guard bypass.
- Narrow baseline, snapshot, ignore, and expected-failure exceptions are implementer decisions when each entry is verified against its source and the PR records the reason (for example tool-owned metadata in an upgrade snapshot while user data stays exact). They never mask a real regression or user-data change. Blanket or unverified exceptions need approval. Exact shrink-only ratchet updates are maintenance.
- `CODEOWNERS` routes review; restricted/security paths and material changes need listed-owner involvement ([review governance](.agents/skills/openclaw-pr-maintainer/SKILL.md#codeowners-review)).
- Complete the workflow's review/merge gates; resolve substantive findings or explain rejections. Verify remote outcomes before success or cleanup; reconcile uncertain writes, never retry blindly.
- Stage only intended files; concise Conventional Commits with verified author/writer identity. Preserve contributor credit; team-session credit needs consented, verified humans and the canonical backlink. A bare URL grants no public mutation authority. Keep PR bodies current with problem, solution, impact, and evidence; use body files for shell-sensitive text.

## Read when relevant

Read matching guides in full; commands and details stay with them.

- **Plugins/SDK:** [plugins](extensions/AGENTS.md), [loader](src/plugins/AGENTS.md), [SDK](src/plugin-sdk/AGENTS.md) (owns public boundary expansion, including outside callers).
- **Channels/message actions:** [channel boundary](src/channels/AGENTS.md), [channel responsibilities](docs/plugins/sdk-channel-plugins.md).
- **Agent tools, prompts, admission, lifecycle:** [agents](src/agents/AGENTS.md), [Gateway](src/gateway/AGENTS.md).
- **Control UI:** [UI guide](ui/AGENTS.md), including state shared with other Gateway clients.
- **Storage:** [database schemas](docs/reference/database-schemas.md) and its subpages; read its approval checkpoint before schema, transaction, retention, or recovery changes.
- **Config migration:** [Doctor transforms](docs/gateway/doctor/config-migrations.md), never new runtime compatibility readers.
- **Audit/identity:** [audit doctrine](docs/gateway/audit.md); provenance is opt-in, never authorization; changes to collection, reader scope, retained fields, bounds, or contracts need approval.
- **Codex-backed behavior:** personally inspect and cite the exact sibling `../codex` source first; other agents' reports don't substitute. Routes use `openai` (`openai-codex` only in migration); refresh [the harness guide](docs/plugins/codex-harness.md) from `model/list` on upgrades.
- **Validation:** [test suites](docs/help/testing/suites.md) lists commands; [writing tests](docs/help/testing/writing-tests.md) for authoring.
- **GitHub:** [contribution rules](CONTRIBUTING.md), the PR template, [review feedback](docs/reference/pull-request-review-flow.md); `scripts/pr` follows the [scripts guide](scripts/AGENTS.md).
- **Docs:** [docs guide](docs/AGENTS.md); update docs with behavior; fix notes go in PRs (`CHANGELOG.md` is release-owned).
- **Releases:** the release workflow and [release contract](docs/reference/RELEASING.md); preserve the selected cut and identity through publication and verification. npm-format lock mirrors are verified against `pnpm-lock.yaml`, published in dependency evidence, and kept out of npm tarballs.
- **Secrets/advisories:** [secrets](docs/gateway/secrets.md), [auth](docs/auth-credential-semantics.md), [security reporting](SECURITY.md).
- **Live channels/native apps:** the scoped guide; Telegram claims need Test Server userbot proof (Convex-leased credentials), platform claims real device evidence, Mac permission proof a stable, [signed](docs/platforms/mac/signing.md) app.
