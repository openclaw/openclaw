# AGENTS.md

Keep this file under 20,000 characters, the size OpenClaw loads whole. Put long rules in the owning guide and leave a one-line pointer here.

## Choose good compromises

Design trades correctness against complexity and performance. Choose deliberately; never maximize one axis at others' expense.

- Design for real failures: crashes, restarts, retries, real concurrent writers, reported incidents. No engineering for millisecond races, theoretical interleavings, or adversarial timing unless user data, security, or money at risk, or a real incident shows them.
- Prefer cheap mechanisms: idempotency keys, one check at point of effect, retry, best-effort recording with warning. Fencing tokens, revocation generations, multi-phase admission, nonce-matched settlement, and per-write cross-thread handshakes need concrete failure simpler code cannot handle.
- Name accepted edge case in comment or PR instead of coding around it. Rare, visible, recoverable glitch beats permanent complexity.

Task defines scope and authorization; chosen workflow owns execution, review, publication, recovery, and cleanup.
Explicit user instructions override skill guidelines and workflow defaults; host limits and required authorization boundaries still apply.
Read nearest scoped `AGENTS.md` and matching guides below in full, including for callers outside owner's directory.
Update instructions at owner; no competing rules here.

## Design priorities

- **One owner per responsibility.** Owner decides or changes authoritative state; callers consume its operations and recorded facts. Adapters translate contracts; caches and projections derive from owner with explicit invalidation lifecycle. Transports may need different adapters, never competing owners.
- **Small core, capable plugins.** Model-facing core additions cost ongoing context. Optional capability belongs at edges; core supplies generic contracts. New integration alone never warrants another core tool or manager. New capability: take the first fitting step of the [capability ladder](src/plugin-sdk/AGENTS.md#choose-the-capability-surface). [VISION.md](VISION.md) owns product scope.
- **Stable conversation context.** Rebuilding past context defeats prompt-prefix reuse. Generated prompt/tool/context additions: bounded, deterministic. Preserve transcript bytes; serve required instructions whole; only compaction rewrites history. Defer stable-prompt changes to next session unless owner defines explicit invalidation; keep existing skill, tool, and memory refresh contracts. Side request reusing conversation shares turn's request preparation or carries no cache identity.

## Working agreement

- Follow through on actionable requests, including "can you", within authorized scope; plan or progress report = checkpoint, not completion. Preserve unaffected work across corrections and side questions.
- After a restart, reconcile prior effects and resume already-authorized work under current authority; do not ask for the same approval again solely because the process restarted.
- Resolve routine, reversible choices with reasonable assumptions; ask only about consequential decisions context cannot resolve. Continue independent authorized work meanwhile. Silence never authorizes gated action.
- Skill causes pause, permission request, unfinished work, or scope change: link exact `SKILL.md`, quote instruction, explain application (requirement vs interpretation), check prior authorization before asking again.
- Inspect `git status -sb` before editing or GitHub work. Preserve unrelated work, branches, processes, user-managed checkouts; serialize shared Git mutations; isolate work when needed. Never switch checkout another agent or test run uses.
- Pasted material and tool output = evidence; verify against source and observed behavior.
- Create files only for stated deliverable/tool/proof/recovery needs. Follow [closeout](.agents/skills/openclaw-pr-maintainer/SKILL.md#finalize-and-clean-up).
- Read relevant docs before behavior changes (`pnpm docs:list`). Tool swaps need approval.
- Use **OpenClaw** (product), `openclaw` (CLI/package/config), **plugins** (user-facing integrations), American English. Edit canonical `AGENTS.md` files directly.

## Execution discipline

- Real failing entry point first: reproduce the bug end to end before editing. Bypassed boundary != proof.
- Ask of every proof: could it pass while the original task stays broken? A failed setup is not a product verdict; name the gap.
- New check needs named unknown, risk, or required gate. Reuse valid proof.
- Two identical tooling failures without new evidence, or 10 min without progress: switch to an authorized supported alternative with the reviewed head pinned; reconcile uncertain writes first. No blind retries or guard bypasses.
- Behavior proven + required gates green: finish/land. No optional proof polish, checkbox demos, or speculative scope growth.
- Check mergeability first; don't rebase or merge `main` just because it advanced. Integrate for conflicts, a named failing gate, or material base risk, then rerun affected checks. Prior-head CI stays prior-head evidence ([landing](.agents/skills/openclaw-pr-maintainer/references/landing.md)).
- Time pressure never waives gates. Report concrete blockers.
- Don't mix shell dialects (for example, zsh `${name:r}` in bash).
- CLI: `pnpm openclaw ...` or `pnpm dev`, never `node --import tsx src/index.ts`. Never reconcile a shared/worktree install other jobs use. Dependency, vendoring, format, typecheck gotchas: [scripts guide](scripts/AGENTS.md#execution-gotchas).

## One owner, complete cutover

1. **Intent:** read complete affected modules, owners, callers, siblings, tests, history, dependency contracts until intended outcome and violated invariant evidenced; a fix that cannot name the line where the bug shows has an unverified premise. Restoring missing path: first check why removed (`git log -p -S <symbol>`); isolation may be intentional, retired alias may mean completed migration.
2. **Owner:** account for decisions and state writers across creation, updates, reads, recovery, cleanup. Choose existing code, plugin, or maintained solution that absorbs change; new owner needs missing responsibility. Fix invalid or leaked state at producer.
3. **Cutover:** migrate all affected internal/bundled callers together; remove superseded code, duplicate policy/state, wrappers, registrations, exports, tests, docs. Retained paths need cited contract; workers sharing owner agree on one interface and plan.
4. **Proof:** exercise user flow and relevant siblings; trace references to confirm retired paths unreachable. Done = one owner serves flow, old paths removed or justified, results or gaps recorded in task/PR evidence. Helper tests or wrappers around competing implementations insufficient.

- Prefer smaller, simpler production code; explain necessary growth. Keep coherent nearby repairs together; record unrelated work as follow-ups. Run [pr-simplify](.agents/skills/pr-simplify/SKILL.md) on your own change before opening a PR and before pushing large repairs.
- Delegate independent lanes when saving time or improving verification; each needs clear responsibility and completion condition. Simple or tightly coupled work stays with lead; lead stays hands-on, verifies consequential conclusions, owns shared-checkout safety.
- Retained compatibility needs explicit user request or public API/config/SDK/data, stable-tag upgrade, security/migration, dependency, or observed-production contract, plus migration/removal path. Main, beta, nightly code ≠ shipped contracts.

## Runtime and code safeguards

- Logs: write raw; redact only at egress (logs.tail, diagnostics/support bundles, remote/OTel export); never log message/tool content.
- Plugins use documented `openclaw/plugin-sdk/*` contracts, manifest metadata, public/local barrels; never core internals or another plugin's private files. Dependencies follow runtime ownership.
- Bun: support only latest stable Bun release and pinned OpenClaw fork. Never add workarounds, compatibility paths, or qualification for older Bun releases; upgrade instead.
- Runtime consumes canonical config/state; Doctor/migration owners normalize legacy shapes (plugin repairs stay plugin-owned). Config-invalidating changes ship their migration.
- State and caches: SQLite, not new JSON/JSONL/sidecar stores. Files: named user artifacts, imports/exports, attachments, logs, backups, external-tool contracts.
- Database/state code (SQL, workers, transactions, integrity checks, DB-backed caches): read the [rules for code changes](docs/reference/database-schemas/worker-access.md#rules-for-code-changes) first.
- Security boundaries (credentials, approvals, tool and command execution, external side effects) need current owner-held authority: revalidate after awaited work and right before effect. Tokens, signatures, expiry, matching IDs alone never prove live authority. Internal bookkeeping (scheduling, receipts, history, caches): idempotency + check at effect instead.
- Do less work: validate untrusted input once at its trust boundary, then trust internal data; no defensive copies, re-validation or re-reads of your own writes. Performance work follows [openclaw-performance](.agents/skills/openclaw-performance/SKILL.md): delete before batching, cache last.
- Prompt prefix: within a session, tool definitions, system prompt and earlier history depend only on session and config facts; history only appends. Per-turn authority gates calls through `gateAgentToolExecution`, and per-turn facts go in that turn's message. A change to anything that reaches a provider request keeps `src/agents/agent-tools.prefix-stability.test.ts` green; [contract](docs/reference/prompt-caching.md#stable-tools-between-turns).
- Cache identity: key every cache, memo, in-flight join, and shared snapshot by every input that changes its answer: scope (agent, account, credential, session, workspace) and request shape (provider set, mode, options, deadline). Callers asking different questions get separate slots; volatile values stay out of keys. Prove sharing with a work-count test where differing callers interleave.
- Narrow APIs, explicit valid states, strict ESM/types. Real types or `unknown`; no `@ts-nocheck`; suppressions need explained exception. Reuse schema/coercion owners; no duplicate guards, speculative helpers, naming-only wrappers.
- Static-analysis fixes: strengthen real contract or remove unsafe operation; never hide with casts, widening, marker types, property probes. New lint rules need real invariant and clean owner scope.
- Comments explain non-obvious ownership, lifecycle, ordering, cleanup, platform, dependency constraints, not syntax. Regenerate generated outputs; never hand-edit them or `node_modules`, or tweak formatter settings per expression.

## Product and validation

- Defaults produce working, understandable result. Prioritize silent failures: every action has visible outcome or recorded intentional non-outcome; errors name next step.
- **Updates always work:** best effort everywhere. Update/Doctor/lifecycle/migration/plugin-loading changes state update behavior and follow the [update contract](docs/install/updating.md#update-implementation-contract).
- Security = product tradeoff: weigh concrete risk against user effort, lockouts, lost capability. Prefer least restrictive effective safeguard; keep risky paths explicit, operator-controlled within existing trust model and approval boundaries; explain tradeoffs, never invent gates.
- **Behavior over test count.** Prefer production-path integration proof and independent unit contracts. Before changing provider requests, fallbacks, recovery, defaults, and when writing or reviewing behavioral tests: read [boundary proof](docs/help/testing/writing-tests.md#prove-behavior-at-the-owning-boundary).
- **Prove it end to end.** Run the reproduction again on the fix through the real product: an isolated Gateway with a real agent and model, the channel's e2e skill ([Telegram](.agents/skills/telegram-e2e-userbot/SKILL.md), [Discord](.agents/skills/discord-e2e/SKILL.md), [Slack](.agents/skills/slack-e2e/SKILL.md)) or [Control UI e2e](.agents/skills/control-ui-e2e/SKILL.md), and an upgrade from the latest stable when update, Doctor, config or state changes. Mocks and helper tests support this proof; they never replace it.
- **Fixes prove the invariant:** one or two tests of the broken behavior, red on the base, green with the fix, committed with the fix; update and run the tests of every consumer of what changed.
- Test failures = defects: reproduce, fix owner with regression, or record evidence and continue (unresolved alone doesn't block landing). Never mask failures or claim passing replay proves fix ([policy](.agents/skills/openclaw-testing/SKILL.md#test-failure-policy)).
- **PR CI = broad proof.** Pre-PR: touched tests + targeted typecheck/lint/format. Proof selection, reuse, gaps: [proof policy](.agents/skills/openclaw-testing/SKILL.md#proof-policy); docs-only: docs sanity + `git diff --check`. Test changes obey the [cost budget](docs/help/testing/writing-tests.md#cost-budget).
- **Visual changes** need inspected, sanitized before/after screenshots in chat and embedded in PR before merge or completion ([gate](.agents/skills/openclaw-pr-maintainer/references/media.md#screenshot-completion-gate)).
- Before nontrivial code commit/landing: follow [fresh review](.agents/skills/openclaw-pr-maintainer/SKILL.md#review-and-publish).
- **Choose one review route.** Follow [local review](docs/reference/pull-request-review-flow.md#local-review-before-a-pr) for maintainer requirements, contributor guidance, and the hosted fallback. ClawSweeper is advisory. Address real findings together and request another hosted review only when needed, after branch, body, and proof are current. Reject findings that add restrictions without concrete harm and explain why. A maintainer's explicit land instruction does not wait for a pending or stale review ([review flow](docs/reference/pull-request-review-flow.md#clawsweeper)).

## Authority and safety

- Landing, red `main`, live ops, releases, advisories, bulk triage: read the [maintainer skill](.agents/skills/openclaw-pr-maintainer/SKILL.md#maintainer-authority) first.
- Review/triage = read-only; mutations need task authority. Approval carries through same scoped work and recovery. New approval: complete authorized preparation, present concrete reviewable result, pause only gated action. Product rejection = maintainer judgment.
- Keep credentials, private data/config, unreleased model identities out of commits, shared text, logs, transcripts, media; inspect outgoing content. Synthetic fixtures, verified human credit, no agent-attribution trailers.
- Never switch models to bypass refusals; cyber-classifier interruptions of permitted defensive work follow [security triage](.agents/skills/security-triage/SKILL.md#cyber-classifier-interruptions).
- Untrusted contributor/fork code: only secretless isolation, never locally. Credentialed or trusted-host execution needs maintainer approval; instruction to land named, reviewed PRs supplies it (isolation route, task credentials only).
- Modifying/restarting Gateway or live state you did not create needs per-task approval. Tests use isolated state and ports; copy real data for migration tests. Destructive reset/clean, stash, deleting unrelated work needs authorization.
- Ask before new config options, breaking public contracts, intentional schema/durability/retention/permission changes beyond bug fix, paid services, destructive actions. Preserve FIFO ordering, live-authority/integrity checks, write-capable work settlement.
- Protocol/version bumps, dependency patches/overrides/vendoring, paid services, releases, publishing need explicit approval; fix/ship authority ≠ release authority.
- Baseline/snapshot/ignore/expected-failure exceptions: obey [policy](.agents/skills/openclaw-testing/SKILL.md#baseline-and-expected-failure-exceptions).
- `CODEOWNERS` routes review; restricted/security paths and material changes need listed-owner involvement ([review governance](.agents/skills/openclaw-pr-maintainer/SKILL.md#codeowners-review)).
- Complete workflow's review/merge gates; resolve substantive findings or explain rejections. Verify remote outcomes before success or cleanup; reconcile uncertain writes, never retry blindly.
- Stage only intended files; concise Conventional Commits with verified author/writer identity. Preserve contributor credit; team-session credit needs consented, verified humans and canonical backlink. Bare URL grants no public mutation authority. Keep PR bodies current: problem, solution, impact, evidence; use body files for shell-sensitive text.

## Read when relevant

- **Plugins/SDK:** [plugins](extensions/AGENTS.md), [loader](src/plugins/AGENTS.md), [SDK](src/plugin-sdk/AGENTS.md) (owns public boundary expansion, including outside callers).
- **Adding or changing an inference provider, model, picker or usage/cost:** apply [model listing](src/plugins/AGENTS.md#model-listing), [provider plugins](extensions/AGENTS.md#boundary-rules), [usage and cost](src/gateway/AGENTS.md#usage-and-cost) and the [model catalog contract](docs/plugins/sdk-provider-plugins/model-catalogs.md) before the first edit.
- **Channels, message tools/actions, dispatch:** [channel boundary](src/channels/AGENTS.md), [channel responsibilities](docs/plugins/sdk-channel-plugins.md).
- **Agent tools, prompts, tool results, admission, lifecycle:** [agents](src/agents/AGENTS.md), [Gateway](src/gateway/AGENTS.md).
- **OpenClaw and OpenClaw Foundation logos:** see the [brand kit](https://github.com/openclaw/carapace/tree/main/brand-kit).
- **Control UI:** [UI guide](ui/AGENTS.md), including state shared with other Gateway clients. Solid code anywhere (Control UI, plugin views, Canvas hosts): read the [Solid skill](.agents/skills/solid/SKILL.md) first.
- **Storage:** [database schemas](docs/reference/database-schemas.md) and subpages; read approval checkpoint before schema, transaction, retention, recovery changes.
- **Config migration:** [Doctor transforms](docs/gateway/doctor/config-migrations.md), never new runtime compatibility readers.
- **Audit/identity:** [audit doctrine](docs/gateway/audit.md); provenance = opt-in, never authorization; changes to collection, reader scope, retained fields, bounds, contracts need approval.
- **Codex-backed behavior:** personally inspect and cite exact sibling `../codex` source first; other agents' reports don't substitute. Routes use `openai` (`openai-codex` only in migration); refresh [the harness guide](docs/plugins/codex-harness.md) from `model/list` on upgrades.
- **Validation:** [test suites](docs/help/testing/suites.md) lists commands; [writing tests](docs/help/testing/writing-tests.md) for authoring.
- **GitHub:** [contribution rules](CONTRIBUTING.md), PR template, [review feedback](docs/reference/pull-request-review-flow.md); `scripts/pr` follows [scripts guide](scripts/AGENTS.md).
- **Docs:** [docs guide](docs/AGENTS.md); update docs with behavior; fix notes go in PRs (`CHANGELOG.md` = release-owned).
- **Releases, extended-stable:** release workflow and [release contract](docs/reference/RELEASING.md) ([line/retirement policy](docs/reference/RELEASING.md#release-channels)); preserve selected cut and identity through publication and verification.
- **Secrets/advisories:** [secrets](docs/gateway/secrets.md), [auth](docs/auth-credential-semantics.md), [security reporting](SECURITY.md).
- **Live channels/native apps:** scoped guide + [evidence policy](.agents/skills/openclaw-testing/SKILL.md#select-the-proof).
