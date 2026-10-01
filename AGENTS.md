# Arxi OpenClaw fork: coding-agent instructions

This repository contains the OpenClaw fork used by Arxi. Follow the Arxi workspace
AGENTS.md and the applicable subtree AGENTS.md. OpenClaw owns agent behavior;
Arxi product/hosting boundaries remain in the workspace contract.

## Arxi delivery

Read the current containing Arxi workspace `AGENTS.md`, including above a task
worktree's Git root. It owns freshness, authorization, focused proof and completion.
For standalone checkouts, preserve WIP, fetch the target revision and validate in a
synchronized isolated checkout on `arxi-production`; runtime delivery uses current
Ops artifact/golden, lifecycle fences, rollback and real Telegram acceptance.

- Repository-controlled installs, tests, builds, formatters and scripts run on the
  server. GitHub hosts source/PRs; disabled upstream workflows are reference-only.
- Select checks from current source for the affected contract. Reuse passing proof
  with a relevant input comparison and final-head identity; never chase a moving
  main with repeated full gates. Source-only instructions/docs need no runtime
  rebuild, activation or production health check.
- `VISION.md` supplies direction. Read linked guidance only for the changed seam.
  Preserve user decisions; old assistant text, memories and reports are clues,
  not current state or permission. Search current source for moved documentation.
- For Codex protocol/runtime changes, inspect the matching source version; the
  workspace `codex/` checkout alone does not prove installed-version equivalence.
- Repair the owning invariant and prove the failing behavior. Do not hide failures
  with retries, larger timeouts, weaker assertions or mocks. Expand only when
  evidence requires it; keep unrelated refactors outside the requested release.
- Use existing plugins/owners when adequate. New helpers and abstractions must
  simplify the requested behavior. File length alone is advisory, not a reason
  to split code or delay a passing functional change.
- Product/docs/UI wording uses "plugin/plugins"; `extensions/` is internal.
  `AGENTS.md` is canonical; `CLAUDE.md` is a symlink. Runtime templates/fixtures
  named `AGENTS.md` are product data, not contributor instructions.

## Product Doctrine

`VISION.md` owns direction; this section owns judgment. Apply to triage, review, design, and landing.

- Judge from the operator's chair: a competent person following the docs must end with a working, comprehensible bot. Code correctness is table stakes, not the verdict.
- Severity order: silent failure > crash > missing feature. Every user or agent action ends in a visible outcome or a recorded, intentional non-outcome; an action that silently produces nothing is the worst bug class in this repo.
- Defaults are the product. Most operators never change them, so the out-of-box path gets the best experience we can ship, not the most conservative one; a regression on a default path outranks feature work and config-path bugs.
- Record facts where they happen; read them where they are needed. Answering "did X happen?" by combining several indirect signals rots as sibling paths evolve; prefer a recorded fact at the boundary that owns it.
- The model's experience is the product. Capability that prompt/tool text does not mention — or contradicts — does not exist for users. Tool results are prompts: return what the model needs next, not a bare ack. Review prompt and description text with the same rigor as code.
- Latency is model round-trips, not milliseconds. Collapse act-then-observe pairs into one tool result; keep expensive resources warm across a session.
- Never dead-end the agent: failure text states what to try next; unavailable tools are hidden by gating, not left to fail; missing pieces provision automatically where safe. Auto-provisioning a missing default is product behavior, not a compat fallback — Architecture's fallback-deletion rules do not forbid it.
- A capability shipped off by default needs a named enablement path (onboarding, doctor hint, preset, or docs surfacing) in the same change. Dark-shipped features are a review smell.
- Security is a calibrated tradeoff, not a veto. Strong defaults are required; a change that protects a path by deleting the capability, or by making the normal flow unusable, is not the fix — gate it, scope it, or make the risky step explicit and operator-owned. Refusing a capability outright needs a concrete exploit path, not a hypothetical one.

## Architecture

Read [.agents/guidance/architecture.md](.agents/guidance/architecture.md) when
changing runtime ownership, plugin/core boundaries, configuration, persistence,
compatibility, or model context. It preserves the concrete design constraints.
The requested feature/fix authorizes its necessary internal design and migration
work. Ask only for an unresolved user-visible, data-loss, permission or incompatible
public-contract decision; existing acceptance remains valid.

## Execution Identity Audit

Read [.agents/guidance/execution-identity.md](.agents/guidance/execution-identity.md)
when changing audit identity collection, storage, receipts, or inspection.
Diagnostic provenance never grants authority; collection and inspection retain
their explicit privacy and permission boundaries.

## Commands

Select exact commands from [.agents/guidance/commands.md](.agents/guidance/commands.md)
when installing dependencies or running checks. All commands execute on the server.

## Validation

- Untrusted contributor/fork code must not run on the workstation or a
  credential-bearing production host. Review source first and obtain explicit
  owner approval for a suitably isolated production-host execution environment;
  Arxi has no hosted-CI fallback.
- Prose/instruction-only changes: inspect the diff, check whitespace and relevant
  links/formatting on the server. No runtime rebuild, behavior test, or automatic
  review loop is required unless the change actually alters such a contract.
- Bounded code fixes: focused owner tests, relevant changed type/lint/guard
  checks, and a direct diff review. Use `$autoreview` only when explicitly
  requested or a concrete unresolved risk calls for independent review. Broaden
  or repeat proof only for accepted fixes, failures, or new evidence.
- Auth, isolation, durability, migrations, public protocols, delivery, ordering,
  recovery, packaging, and releases need their applicable boundary/regression
  and integration gates for the changed contract; the category alone does not
  require a full suite, extra review agent, or repeated autoreview. Preserve
  exact-head evidence.
- Choose tests by the affected contract; `$openclaw-testing` helps when selection
  is unclear. Upstream hosted-compute recipes do not apply to Arxi.
- UI changes need inspected before/after captures from an isolated running surface.
  Gateway flows use an isolated state directory and owned port. Channel-visible
  behavior can use boundary harness proof for development; runtime release still
  requires the real Telegram canary (`$telegram-e2e-userbot` on the server).
- Do not bypass failing gates. Fix task-related failures; identify unrelated
  current-main failures with scoped evidence and report remaining blockers.
  Report exactly which proof is missing when the environment cannot provide it.

## Code

Read [.agents/guidance/code.md](.agents/guidance/code.md) for implementation and
code review. It retains TypeScript, lint, naming, and module-boundary conventions.

## Tests

Read [.agents/guidance/tests.md](.agents/guidance/tests.md) when writing tests or
setting up proof. Use disposable state and isolated gateways; never weaken checks
or alter operator state to manufacture a passing result.

## ClawSweeper Review Policy

Use [.agents/guidance/clawsweeper-review.md](.agents/guidance/clawsweeper-review.md)
for ClawSweeper reviews and its review findings, not as a preflight for all tasks.

## GitHub / PRs

Use [.agents/guidance/github.md](.agents/guidance/github.md) when creating or
managing issues, PRs, reviews, or landing. Arxi's server-receipt landing contract
above takes precedence over upstream CI and `scripts/pr` procedures.
`CODEOWNERS` routes reviewers; it does not itself establish enforced approval.
Preserve restricted/security ownership and verify actual protection rules when
relevant. For upstream ownership/review governance changes, follow the organization
owner authorization requirements in `CONTRIBUTING.md`; Arxi fork policy changes
follow the Arxi owner's explicit direction. Neither waives GitHub-enforced review.

## Tooling Gotchas

Consult [.agents/guidance/tooling.md](.agents/guidance/tooling.md) for a relevant
shell/Git/GitHub problem; it is not required reading before ordinary commands.

## Docs / Changelog

- Review documentation/instructions against the current affected contract and
  run relevant diff/link/format checks. A scoped edit does not require a full-repo
  inventory, extra review agent or documentation workflow; use a skill only when
  it resolves a concrete uncertainty in the task.
- Product-facing docs track changed behavior/API. When upgrading the Codex harness,
  refresh the model snapshot in `docs/plugins/codex-harness.md` from its model list.
- `CHANGELOG.md` is release-generated. Put release-note context for normal
  fixes/features/performance work in the PR body or commit instead.

## Git

- Commit with standard Git commands; stage intended files only.
- Commits: conventional-ish, concise, grouped.
- No manual stash/autostash unless explicit. Branch switches and task-owned worktrees are allowed when useful; preserve user-managed checkouts and unrelated work.
- `main`: no merge commits; rebase on latest `origin/main` before push. After one green run plus clean rebase sanity, do not chase moving `main` with repeated full gates.
- User says `commit`: your changes only; `commit all`: all changes in grouped chunks; `push`: may `git pull --rebase` first; `ship it`: commit intended changes, pull --rebase, push.
- Do not delete/rename unexpected files; ask if blocking, else ignore.
- Bulk PR close/reopen >50: ask with count/scope.

## Security / Release

- Never publish internal or unreleased model identifiers in code, fixtures, commits, PRs, issues, comments, logs, transcripts, or screenshots/video. Use synthetic identifiers in fixtures; tests requiring real models must use stable public IDs. Elsewhere, use stable public model IDs—or “Codex”. Sanitize copied commands and check diffs and proof artifacts before publishing.
- Never commit real phone numbers, videos, credentials, live config.
- Secrets: channel/provider creds in `~/.openclaw/credentials/`; shared model auth profiles in `~/.openclaw/state/openclaw.sqlite`, with agent-local profiles overriding the shared read-through base; see `docs/auth-credential-semantics.md`.
- SecretRef failures isolate to the smallest known owning surface; unknown ownership fails closed. Gateway starts degraded (exact owner marked configured-unavailable, typed redacted diagnostic, no implicit credential fallback) rather than refusing startup, except for its own ingress protection or structurally invalid config. Doctor and status list every degraded owner. Full doctrine: `docs/gateway/secrets.md`.
- Necessary dependency patches/overrides/vendor fixes are implementation decisions within the requested repair. Record their reason and validate the affected dependency contract; unrelated dependency changes remain outside scope. Patched dependencies use exact versions.
- Release/package guards: no hard-coded retired-package denylists; use generic artifact/dependency checks or fix build source.
- `pnpm-lock.yaml` is the product dependency security review surface; `.github/release/clawhub-cli/package-lock.json` separately pins trusted release tooling. Published packages bundle runtime dependencies where configured and never ship lockfiles; other npm-format locks exist only transiently during checks and publish staging.
- An Arxi ship/deploy request authorizes its versioning and activation through current Ops contracts without another approval. Publishing upstream OpenClaw packages is a separate scope; when explicitly requested, use `$release-openclaw-maintainer` (nightlies: `$release-openclaw-nightly`). Disabled upstream release CI does not apply to the Arxi fork.
- During an active release, freeze the operator-selected cut SHA and release identity through publish and verification; touch `main` only for the smallest critical main-owned blocker or on operator request, then return to the release branch.
- GHSA/advisories: never create, open, draft, update, publish, or otherwise mutate a GitHub Security Advisory, GHSA temporary fork, private security-review repository, or security-only review artifact unless the user explicitly asks for that exact advisory/security workflow action. Terms such as "security-sensitive", "hardening", "private review", "unshipped", or "unreleased" grant no advisory authority; unshipped hardening uses the normal code/PR workflow. Routes: `$openclaw-ghsa-maintainer` / `$security-triage`. Secret scanning: `$openclaw-secret-scanning-maintainer`.

## Platform / Ops

Use [.agents/guidance/platform-ops.md](.agents/guidance/platform-ops.md) for native
app and gateway operations. Preserve isolation, signing, and channel-delivery
contracts. Never edit `node_modules` or expose live credentials/state in source.
