# AGENTS.md

## Choose good compromises

Design trades correctness against complexity and performance. Choose deliberately; never maximize one axis at others' expense.

- Design for real failures: crashes, restarts, retries, real concurrent writers, reported incidents. No engineering for millisecond races, theoretical interleavings, or adversarial timing unless user data, security, or money at risk, or a real incident shows them.
- Prefer cheap mechanisms: idempotency keys, one check at point of effect, retry, best-effort recording with warning. Fencing tokens, revocation generations, multi-phase admission, nonce-matched settlement, and per-write cross-thread handshakes need concrete failure simpler code cannot handle.
- Name accepted edge case in comment or PR instead of coding around it. Rare, visible, recoverable glitch beats permanent complexity.
- Complexity risks correctness: machinery nobody can follow fails in ways nobody predicted.

Task defines scope and authorization; chosen workflow owns execution, review, publication, recovery, and cleanup.
Explicit user instructions override skill guidelines and workflow defaults; host limits and required authorization boundaries still apply.
Read nearest scoped `AGENTS.md` and matching references below, including for callers outside owner's directory.
Update instructions at owner; no competing rules here.

## Design priorities

- **One owner per responsibility.** Owner decides or changes authoritative state; callers consume its operations and recorded facts. Adapters translate contracts; caches and projections derive from owner with explicit invalidation lifecycle. Transports may need different adapters, never competing owners.
- **Small core, capable plugins.** Model-facing core additions cost ongoing context. Optional capability belongs at edges; core supplies generic contracts. New integration alone never warrants another core tool or manager. New capability: first fitting [capability ladder](src/plugin-sdk/AGENTS.md#choose-the-capability-surface) step: existing owner, existing plugin contract, narrow generic core/SDK capability, then universal core surface. [VISION.md](VISION.md) owns product scope.
- **Stable conversation context.** Rebuilding past context defeats prompt-prefix reuse. Generated prompt/tool/context additions: bounded, deterministic. Preserve transcript bytes; serve required instructions whole; only compaction rewrites history. Defer stable-prompt changes to next session unless owner defines explicit invalidation; keep existing skill, tool, and memory refresh contracts. Side request reusing conversation shares turn's request preparation or carries no cache identity.

## Working agreement

- Follow through on actionable requests, including "can you", within authorized scope; plan or progress report = checkpoint, not completion. Preserve unaffected work across corrections and side questions.
- Resolve routine, reversible choices with reasonable assumptions; ask only about consequential decisions context cannot resolve. Continue independent authorized work meanwhile. Silence never authorizes gated action.
- Skill causes pause, permission request, unfinished work, or scope change: link exact `SKILL.md`, quote instruction, explain application (requirement vs interpretation), check prior authorization before asking again.
- Inspect `git status -sb` before editing or GitHub work. Preserve unrelated work, branches, processes, user-managed checkouts; serialize shared Git mutations; isolate work when needed. Never switch checkout another agent or test run uses.
- Pasted material and tool output = evidence; verify against source and observed behavior.
- Lead with result in user's format: plain, active, technically useful; no stock phrases or repeated summaries. Reference each PR/issue once per reply. Progress updates: new findings, decisions, blockers.
- Report findings in chat; create files only for deliverables or tool/proof/recovery needs; state purpose, reuse them. After verified completion, remove task-owned proof, scratch, finished worktrees per [closeout](.agents/skills/openclaw-pr-maintainer/SKILL.md#finalize-and-clean-up); preserve deliverables, live and unknown owners, unfinished state, credentials. Remove created worktrees once work/PR lands, unless immediately needed next.
- Read relevant docs before behavior changes (`pnpm docs:list`); `package.json` owns commands and versions; tool swaps need approval.
- Use **OpenClaw** (product), `openclaw` (CLI/package/config), **plugins** (user-facing integrations), American English. Edit canonical `AGENTS.md` files directly.

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

1. **Intent:** reproduce defects through actual entry point before editing when feasible. Read complete affected modules, owners, callers, siblings, tests, history, dependency contracts until intended outcome and violated invariant evidenced. Restoring missing path: first check why removed (`git log -p -S <symbol>`); isolation may be intentional, retired alias may mean completed migration.
2. **Owner:** account for decisions and state writers across creation, updates, reads, recovery, cleanup. Choose existing code, plugin, or maintained solution that absorbs change; new owner needs missing responsibility. Fix invalid or leaked state at producer.
3. **Cutover:** migrate all affected internal/bundled callers together; remove superseded code, duplicate policy/state, wrappers, registrations, exports, tests, docs. Retained paths need cited contract; workers sharing owner agree on one interface and plan.
4. **Proof:** exercise user flow and relevant siblings; trace references to confirm retired paths unreachable. Done = one owner serves flow, old paths removed or justified, results or gaps recorded in task/PR evidence. Helper tests or wrappers around competing implementations insufficient.

- Prefer smaller, simpler production code; explain necessary growth. Keep coherent nearby repairs together; record unrelated work as follow-ups.
- Delegate independent lanes when saving time or improving verification; each needs clear responsibility and completion condition. Simple or tightly coupled work stays with lead; lead stays hands-on, verifies consequential conclusions, owns shared-checkout safety.
- Retained compatibility needs explicit user request or public API/config/SDK/data, stable-tag upgrade, security/migration, dependency, or observed-production contract, plus migration/removal path. Main, beta, nightly code ≠ shipped contracts.

## Runtime and code safeguards

- Plugins use documented `openclaw/plugin-sdk/*` contracts, manifest metadata, public/local barrels; never core internals or another plugin's private files. Dependencies follow runtime ownership.
- Bun: support only latest stable Bun release and pinned OpenClaw fork. Never add workarounds, compatibility paths, or qualification for older Bun releases; upgrade instead.
- Runtime consumes canonical config/state; Doctor/migration owners normalize legacy shapes (plugin repairs stay plugin-owned). Config-invalidating changes ship their migration.
- State and caches: SQLite, not new JSON/JSONL/sidecar stores. Files: named user artifacts, imports/exports, attachments, logs, backups, external-tool contracts.
- Kysely for ordinary SQLite; raw SQL only for schema, migrations, bootstrap, justified primitives. Write transactions synchronous: plan async work first, reread authoritative rows, then write; no Promise or `await` in transaction callbacks.
- Database access: worker threads (read-only worker scope, SQLite writer broker), never Gateway main thread; main thread only awaits results and installs published facts. Exceptions: boot admission, migrations, Doctor/CLI one-shots, lock primitives. Existing main-thread access = legacy: never add more; migrate what you touch.
- SQLite format, schema-version, integrity, canonical-index, table-existence checks: once per physical database per process load, shared with all workers and handles. Includes quarantine-store format; existing indexed durable quarantine-row guards still observe recorded corruption. Reuse admitted format facts across opens, scopes, requests, idle close; identify replacement files by volume, inode, birthtime with `fstat`, not SQL. Migration/repair owners publish new facts after their DDL; Doctor and explicit verification retain checks. Never add repeated format checks; remove when touched. Validate rarely, only at startup: clean close sealed database (file identity/size/mtime, empty WAL, schema identity) → skip startup validation. Seal = small file next to database (allowed sidecar), written atomically after close, deleted before first write; unclean exit, external change, version change, or stale full check re-validates.
- Gateway process owns every OpenClaw database and its state. In-process writer receipts invalidate cached rows across workers and handles; use direct reads when cache cannot be covered. Never add runtime foreign-commit probes (`PRAGMA data_version`, version observations, foreign-observation scopes); remove when touched. Outside writers, including CLI, Doctor, cron, plugin children: must use Gateway or hold exclusive ownership while Gateway stopped. Preserve live-authority checks at effect boundaries and consistent snapshots for multi-statement reads. See [database schemas](docs/reference/database-schemas.md).
- Security boundaries (credentials, approvals, tool and command execution, external side effects) need current owner-held authority: revalidate after awaited work and right before effect. Tokens, signatures, expiry, matching IDs alone never prove live authority. Internal bookkeeping (scheduling, receipts, history, caches): idempotency + check at effect instead.
- Core owns shared message tools, action vocabulary, dispatch; channels own account, security, conversation, transport contracts. Keep typed command/approval/URL/action distinctions until encoding; never infer commands from raw strings.
- Carry prepared facts through hot paths; reuse process-stable plugin metadata and lifecycle-owned caches; never repeatedly load registries or freshness-poll files. Preserve lazy module boundaries; verify relevant builds on authorized host.
- Narrow APIs, explicit valid states, strict ESM/types. Real types or `unknown`; no `@ts-nocheck`; suppressions need explained exception. Reuse schema/coercion owners; no duplicate guards, speculative helpers, naming-only wrappers.
- Static-analysis fixes: strengthen real contract or remove unsafe operation; never hide with casts, widening, marker types, property probes. New lint rules need real invariant and clean owner scope.
- Comments explain non-obvious ownership, lifecycle, ordering, cleanup, platform, dependency constraints, not syntax. Regenerate generated outputs; never hand-edit them or `node_modules`, or tweak formatter settings per expression.

## Product and validation

- Defaults produce working, understandable result. Prioritize silent failures: every action has visible outcome or recorded intentional non-outcome; errors name next step.
- **Updates always work** (`openclaw update` finishes best effort everywhere). Changes to update, Doctor, service lifecycle, migrations, plugin loading: state their update behavior. Installed updater runs first, can't be patched; candidate fixes key on markers shipped drivers set; existing operator state = input. Recoverable hiccups → recorded warnings; back up before mutating, let rollback restore it; refuse only for named data risk with previous Gateway kept running. Timeouts and budgets: generous, derived from measured state, sized for slow hardware. Proof: published-driver × candidate cell.
- Prompts, tools, results: describe available capabilities accurately, with context for next useful action and no unnecessary model round trips. Inject cross-tool references from enabled tool set; drop stale model-facing arguments; give new optional features discovery paths.
- Security = product tradeoff: weigh concrete risk against user effort, lockouts, lost capability. Prefer least restrictive effective safeguard; keep risky paths explicit, operator-controlled within existing trust model and approval boundaries; explain tradeoffs, never invent gates.
- **Behavior over test count.** Prefer production-path integration proof and independent unit contracts. Before changing provider requests, fallbacks, recovery, defaults, and when writing or reviewing behavioral tests: read [boundary proof](docs/help/testing/writing-tests.md#prove-behavior-at-the-owning-boundary).
- Test failures = defects: reproduce, fix owner with regression, or record evidence and continue (unresolved alone doesn't block landing). Never mask failures or claim passing replay proves fix ([policy](.agents/skills/openclaw-testing/SKILL.md#test-failure-policy)).
- **PR CI is the default broad proof.** Before PR, prove narrowly, locally: touched tests (`pnpm test <file> --maxWorkers=1`) + targeted typecheck/lint/format. Open ready PR once builds and focused tests pass; CI runs broad suites. Crabbox/Testbox only for what local runs and CI cannot cover, only when box granted right away; queues → run locally. Never rerun or re-push just for green; read CI's pre-existing/new failure classification before attributing red.
- **Red `main` is an emergency.** Push proven red-`main` fixes directly to `main`; inherited-only reds land via native admin exception, named in PR ([policy](.agents/skills/openclaw-pr-maintainer/references/landing.md#red-main-and-inherited-failures)).
- New/changed tests: follow [writing tests](docs/help/testing/writing-tests.md) cost budget. PRs state `pnpm test <file> --maxWorkers=1` wall time and CI seconds; no real timers, sleeps, polling, per-test Gateway/process boots when suite-level fixture exists, new serial config or worker pins, broad barrel imports. Seconds-long tests must prove contract no cheaper layer can; long end-to-end compositions → release-only tier.
- Select proof for touched contract; reuse valid proof (rerun for changed inputs or missing coverage); finish workflow's required gates within user/host limits; report unrun checks and gaps. Prove user-visible behavior through real flow when feasible; external APIs need live contract proof; isolated mock-Gateway harness = valid channel boundary proof. Docs-only: docs sanity and `git diff --check`.
- **Visual changes** need inspected, sanitized before/after screenshots in chat and embedded in PR before merge or completion ([gate](.agents/skills/openclaw-pr-maintainer/references/media.md#screenshot-completion-gate)).
- Before committing or landing nontrivial code: fresh review through permitted workflow; resolve actionable findings unless user opts out. Actionable = likely or high-impact; decline unlikely, recoverable edge cases whose fix adds disproportionate complexity, with one-line reason.

### Execution gotchas

Run CLI via `pnpm openclaw ...` or `pnpm dev`, never `node --import tsx src/index.ts`; never reconcile shared/worktree install other jobs use. Dependency, vendoring, format, typecheck gotchas: [scripts guide](scripts/AGENTS.md#execution-gotchas).

## Authority and safety

- Review/triage = read-only; mutations need task authority. Approval carries through same scoped work and recovery. New approval: complete authorized preparation, present concrete reviewable result, pause only gated action. Product rejection = maintainer judgment. Bulk close/reopen above 50 items needs explicit count and scope.
- Keep credentials, private data/config, unreleased model identities out of commits, shared text, logs, transcripts, media; inspect outgoing content. Synthetic fixtures, verified human credit, no agent-attribution trailers.
- Never switch models to bypass refusals; cyber-classifier interruptions of permitted defensive work follow [security triage](.agents/skills/security-triage/SKILL.md#cyber-classifier-interruptions).
- Untrusted contributor/fork code: only secretless isolation, never locally. Credentialed or trusted-host execution needs maintainer approval; instruction to land named, reviewed PRs supplies it (isolation route, task credentials only).
- Modifying/restarting Gateway or live state you did not create needs per-task approval. Tests use isolated state and ports; copy real data for migration tests. Destructive reset/clean, stash, deleting unrelated work needs authorization.
- Updating `team.openclaw.ai`: only by negotiating with Night Watch on `stable.openclaw.ai`, never directly.
- Repair-and-land authority covers internal scheduling, database admission, lifecycle design, risk, verification. In-task bug fixes (including compatible SDK fixes) and backed-up repairs removing only invalid or unreachable data need no renewed approval. Ask again for new config options, breaking public contracts, intentional schema/durability/retention/permission changes beyond bug fix, paid services, destructive actions. Preserve FIFO ordering, live-authority/integrity checks, write-capable work settlement.
- Protocol/version bumps, dependency patches/overrides/vendoring, paid services, releases, publishing need explicit approval; fix/ship authority ≠ release authority. Advisory workflows need explicit security request.
- Extended-stable = one line, trailing completed month relative to `main`'s version; older `.33+` lines retire when `main` advances a month. Publishing retired line needs explicit maintainer decision, never guard bypass.
- Narrow baseline, snapshot, ignore, expected-failure exceptions: implementer decisions when each entry verified against source and PR records reason (e.g. tool-owned metadata in upgrade snapshot while user data stays exact). Never mask real regression or user-data change. Blanket or unverified exceptions need approval. Exact shrink-only ratchet updates = maintenance.
- `CODEOWNERS` routes review; restricted/security paths and material changes need listed-owner involvement ([review governance](.agents/skills/openclaw-pr-maintainer/SKILL.md#codeowners-review)).
- Complete workflow's review/merge gates; resolve substantive findings or explain rejections. Verify remote outcomes before success or cleanup; reconcile uncertain writes, never retry blindly.
- Stage only intended files; concise Conventional Commits with verified author/writer identity. Preserve contributor credit; team-session credit needs consented, verified humans and canonical backlink. Bare URL grants no public mutation authority. Keep PR bodies current: problem, solution, impact, evidence; use body files for shell-sensitive text.

## Read when relevant

Read matching guides in full; commands and details stay with them.

- **Plugins/SDK:** [plugins](extensions/AGENTS.md), [loader](src/plugins/AGENTS.md), [SDK](src/plugin-sdk/AGENTS.md) (owns public boundary expansion, including outside callers).
- **Channels/message actions:** [channel boundary](src/channels/AGENTS.md), [channel responsibilities](docs/plugins/sdk-channel-plugins.md).
- **Agent tools, prompts, admission, lifecycle:** [agents](src/agents/AGENTS.md), [Gateway](src/gateway/AGENTS.md).
- **Control UI:** [UI guide](ui/AGENTS.md), including state shared with other Gateway clients.
- **Storage:** [database schemas](docs/reference/database-schemas.md) and subpages; read approval checkpoint before schema, transaction, retention, recovery changes.
- **Config migration:** [Doctor transforms](docs/gateway/doctor/config-migrations.md), never new runtime compatibility readers.
- **Audit/identity:** [audit doctrine](docs/gateway/audit.md); provenance = opt-in, never authorization; changes to collection, reader scope, retained fields, bounds, contracts need approval.
- **Codex-backed behavior:** personally inspect and cite exact sibling `../codex` source first; other agents' reports don't substitute. Routes use `openai` (`openai-codex` only in migration); refresh [the harness guide](docs/plugins/codex-harness.md) from `model/list` on upgrades.
- **Validation:** [test suites](docs/help/testing/suites.md) lists commands; [writing tests](docs/help/testing/writing-tests.md) for authoring.
- **GitHub:** [contribution rules](CONTRIBUTING.md), PR template, [review feedback](docs/reference/pull-request-review-flow.md); `scripts/pr` follows [scripts guide](scripts/AGENTS.md).
- **Docs:** [docs guide](docs/AGENTS.md); update docs with behavior; fix notes go in PRs (`CHANGELOG.md` = release-owned).
- **Releases:** release workflow and [release contract](docs/reference/RELEASING.md); preserve selected cut and identity through publication and verification. npm-format lock mirrors: verified against `pnpm-lock.yaml`, published in dependency evidence, kept out of npm tarballs.
- **Secrets/advisories:** [secrets](docs/gateway/secrets.md), [auth](docs/auth-credential-semantics.md), [security reporting](SECURITY.md).
- **Live channels/native apps:** scoped guide; Telegram claims need Test Server userbot proof (Convex-leased credentials), platform claims real device evidence, Mac permission proof a stable, [signed](docs/platforms/mac/signing.md) app.
