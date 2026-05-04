# Upstream Sync Guide for MAX Messenger Fork

> Evergreen runbook. Lives at `docs/max-plugin/UPSTREAM-SYNC.md`. Update §8
> after every sync. Built from the lessons of PR #3
> ([`upstream-sync-2026.5.2.md`](upstream-sync-2026.5.2.md)) and PR #6
> ([`upstream-sync-post-phase-1b.md`](upstream-sync-post-phase-1b.md)).

## §1 Why this exists

This fork (`mefodiytr/openclaw`) adds `extensions/max-messenger/` — a bundled
channel plugin for the [MAX messenger](https://max.ru/) (Russian messenger by
VK). Upstream `openclaw/openclaw` ships releases roughly weekly, so to keep
the plugin running on a current `openclaw` host we have to sync every 1-2
weeks.

The plugin is small (~25 prod files + 5 test files in
`extensions/max-messenger/`) and depends only on the documented
`openclaw/plugin-sdk/*` boundary, so syncs are usually clean. The two
recurring conflict points are deterministic generated artifacts —
"regenerate, don't hand-merge" is the rule.

## §2 Pre-sync checklist

Before starting:

- [ ] No in-flight PRs on the fork. Either merge or close them first; a sync
      that lands in parallel with another open PR creates avoidable rebase
      pain.
- [ ] Local `main` is clean: `git status` shows nothing modified or
      untracked.
- [ ] Local checkout is on `main` and up-to-date with `origin/main`:
      `git fetch origin && git checkout main && git pull --ff-only origin main`.
- [ ] You have a git remote pointing at upstream (see [§3](#3-first-time-setup-once-per-checkout)
      if not).
- [ ] (If you intend to follow up with [§7](#7-post-sync-verification-optional-but-recommended)
      smoke testing) you have shell access to the BCAi gateway host and a
      MAX bot token still resolves cleanly through `channels.max-messenger`
      config. Sync itself never touches secrets, but the smoke step does.

## §3 First-time setup (once per checkout)

The fork's `origin` points at `mefodiytr/openclaw`. Add upstream as a second
remote:

```sh
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream main
```

Verify with `git remote -v`:

```
origin    https://github.com/mefodiytr/openclaw.git (fetch)
origin    https://github.com/mefodiytr/openclaw.git (push)
upstream  https://github.com/openclaw/openclaw.git  (fetch)
upstream  https://github.com/openclaw/openclaw.git  (push)
```

Never `git push upstream` — we don't have write access there, and any
accidental attempt would refuse the push or, worse, queue a phantom PR
in someone else's repo.

## §4 Standard sync procedure

```sh
# 1. Fresh state
git fetch upstream main
git fetch origin main
git checkout main
git pull --ff-only origin main

# 2. Carve a sync branch (date-stamp the slug for searchability)
git checkout -b sync/upstream-$(date -u +%Y-%m-%d)

# 3. Merge upstream main into the sync branch.
#    Use --no-ff so the merge commit is preserved as a single landing point;
#    a future revert of the entire sync becomes one commit instead of N.
git merge --no-ff upstream/main

# 4. Resolve generated artifacts via regeneration (NOT hand-merge).
#    These are the two files that always conflict because both branches
#    edited them concurrently.
git checkout --theirs src/config/bundled-channel-config-metadata.generated.ts
git checkout --theirs docs/.generated/config-baseline.sha256

pnpm config:channels:gen
pnpm config:docs:gen

git add src/config/bundled-channel-config-metadata.generated.ts
git add docs/.generated/config-baseline.sha256

# 5. If git status shows other unresolved conflicts → STOP and jump to §5.
#    Otherwise:
git merge --continue       # or `git commit --no-edit` if --continue is unavailable

# 6. Run the verification suite (§6). All seven must be exit 0 / clean
#    BEFORE pushing.
pnpm tsgo:extensions
pnpm tsgo:extensions:test
pnpm test extensions/max-messenger
pnpm config:channels:check
pnpm config:docs:check
pnpm exec oxfmt --check --threads=1 extensions/max-messenger
node scripts/run-oxlint.mjs --tsconfig tsconfig.oxlint.extensions.json extensions/max-messenger

# 7. Push and open the PR
git push -u origin sync/upstream-$(date -u +%Y-%m-%d)
# Then open a PR on GitHub: base=main, head=sync/upstream-YYYY-MM-DD,
# title="chore(sync): merge upstream openclaw/openclaw <vXXXX.Y.Z>"
# In the PR body link to §8 of this doc and tick the verification suite.

# 8. Squash-merge the PR (single landing commit on main, tidy history).
```

If verification fails → **do not push**, treat the sync as blocked. See
[§5](#5-what-if-conflicts-beyond-generated-files) for triage.

## §5 What if conflicts beyond generated files

If `git merge upstream/main` reports conflicts on files **other than** the
two generated artifacts in §4 step 4, that means upstream changed something
that the MAX plugin (or the post-Phase-1B analysis) thought was stable.
**Do not muscle through.**

```sh
git merge --abort
```

Then run the upstream-impact analysis flow on a separate branch:

1. Create `analysis/upstream-impact-<date>` (mirror PR #6's structure;
   start by copying [`upstream-sync-post-phase-1b.md`](upstream-sync-post-phase-1b.md)
   as a template).
2. Diff the conflicted files against fork `main` and against
   `upstream/main`.
3. Cross-reference upstream's release notes / `CHANGELOG.md` `## Unreleased`
   for the change.
4. Land the analysis as its own PR with one of these recommendations:
   - **(А)** "Safe to merge" — the conflict was a false positive, retry §4.
   - **(Б)** "Merge with regeneration step" — one or more additional generated
     files now need regeneration; update §4 step 4 in this doc and retry.
   - **(В)** "Merge with code adjustments to max-messenger" — first land a
     separate PR adjusting `extensions/max-messenger/` to the new SDK
     contract, then retry §4.
   - **(Г)** "Hold merge, breaking too risky" — pin the fork to the previous
     upstream version, escalate. Document in §8 and continue working from
     pinned state until upstream stabilizes.

The pattern from PR #6 is the template: methodical fetch of every imported
SDK symbol against `raw.githubusercontent.com/openclaw/openclaw/main/...`
to confirm shape, then a recommendation table. Don't skip the analysis
just because the conflict looks small — the SDK is a load-bearing surface.

## §6 Verification suite explained

What each command in §4 step 6 is actually checking:

| Command                                                                                           | What it asserts                                                                                                                                                                                                     | Failure means                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm tsgo:extensions`                                                                            | TypeScript prod typecheck across every `extensions/*` package — including `max-messenger`'s `src/**/*.ts`                                                                                                           | upstream renamed/removed an SDK type or signature we import; need migration                                             |
| `pnpm tsgo:extensions:test`                                                                       | Same as above, but for `extensions/**/*.test.ts` — covers our four test files (`dedup-cache.test.ts`, `marker-store.test.ts`, `polling-http.test.ts`, `supervisor.integration.test.ts`) plus the harness self-tests | usually surfaces vitest API drift or test-helper renames                                                                |
| `pnpm test extensions/max-messenger`                                                              | Runs the 66 vitest cases (5 files)                                                                                                                                                                                  | runtime regression — supervisor, harness, dedup, marker store, or HTTP wrapper behaves differently against new core     |
| `pnpm config:channels:check`                                                                      | `bundled-channel-config-metadata.generated.ts` is up-to-date with the current `extensions/*/src/config-schema.ts` files                                                                                             | regeneration missed; rerun `pnpm config:channels:gen` and recommit                                                      |
| `pnpm config:docs:check`                                                                          | All four hashes in `docs/.generated/config-baseline.sha256` match the regenerated baseline JSON                                                                                                                     | regeneration missed; rerun `pnpm config:docs:gen` and recommit                                                          |
| `pnpm exec oxfmt --check --threads=1 extensions/max-messenger`                                    | Formatter clean across our extension                                                                                                                                                                                | new oxfmt rule (rare); run `pnpm exec oxfmt --write --threads=1 extensions/max-messenger` and recommit                  |
| `node scripts/run-oxlint.mjs --tsconfig tsconfig.oxlint.extensions.json extensions/max-messenger` | Lint clean across our extension                                                                                                                                                                                     | new oxlint rule landed upstream; fix the violations or, if the rule is wrong for our code, document the disable comment |

If any command is red, **the sync branch is not ready**. Push only after all
seven are green.

> Note: `pnpm config:channels:check` and `pnpm config:docs:check` will
> definitely fail right after step 4 step 4's `git checkout --theirs` and
> before you've run the regeneration commands. That's expected — the
> regenerate steps fix them. The verification suite is run AFTER step 5,
> not in parallel.

## §7 Post-sync verification (optional but recommended)

After the sync PR squash-merges into `main`, you can validate end-to-end
against a real MAX bot if you have a token and time:

1. SSH to the BCAi gateway host (or wherever the fork runs).
2. Pull main and rebuild:

   ```sh
   git pull --ff-only origin main
   pnpm install --frozen-lockfile
   pnpm build
   ```

3. Restart the gateway (managed installs):

   ```sh
   openclaw gateway restart --deep
   openclaw gateway status
   ```

4. Watch logs for one polling cycle:

   ```sh
   ./scripts/clawlog.sh | grep -E "max-messenger|polling"
   ```

5. Send the bot a test message in MAX. Expect:
   - `max-messenger.polling.start` log line at startup
   - one polling round-trip with the message dispatched (the dispatch
     is still skeleton-level per Phase 1B.2 scope; you'll see
     `dispatchInboundEvent` log the `update_type`)
   - graceful shutdown on `openclaw gateway stop` (no `polling.fatal`)

6. If smoke fails — **do not blame the sync first**. The sync just
   re-aligned us with upstream; behavioral regression is more likely a bug
   we already shipped that the new upstream version surfaced. Open an
   issue describing what failed and on which upstream version, and triage
   the MAX plugin code first.

Smoke is optional because (a) it requires a live MAX bot token and (b) the
core verification suite in §6 catches every type-level and unit-test
regression. Skipping smoke is fine for routine syncs; do it before any
production cutover.

## §8 Recent sync history

| Date           | Upstream version | Sync PR  | Notes                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<YYYY-MM-DD>` | `v2026.5.3-1`    | `<PR #>` | First sync after Phase 1B merge. Two generated files conflicted as expected (`bundled-channel-config-metadata.generated.ts`, `docs/.generated/config-baseline.sha256`); resolved via `pnpm config:channels:gen` + `pnpm config:docs:gen`. No SDK API drift; recommendation per [`upstream-sync-post-phase-1b.md`](upstream-sync-post-phase-1b.md) was (Б). |

> Append one row per sync. Keep the table newest-first. Drop rows older than
> ~6 syncs to keep the file readable; archive details in the per-sync
> `analysis/...` PRs.

## §9 Vendor SDK status

| Package               | Pin           | Last verified                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@maxhub/max-bot-api` | `0.2.2` exact | 2026-05-04 (per [`upstream-sync-post-phase-1b.md`](upstream-sync-post-phase-1b.md) §7) | Pin locked by [`plan.md`](plan.md) §8 row 9 / §9 N1. The supervisor in `extensions/max-messenger/src/polling/` deliberately bypasses `bot.start()` per §9 N2 because of [the SDK behavior gaps audited in §6.1.1](plan.md#611-sdk-behavior-audit-maxhubmax-bot-api). The custom HTTP wrapper, marker store, dedup cache, and abort wiring all compensate for those gaps; bumping the SDK does not relax those decisions. |

Periodic checks against npm:

```sh
npm view @maxhub/max-bot-api versions --json
npm view @maxhub/max-bot-api time --json
```

If a `0.2.3+` ships, **do not auto-bump**. Instead:

1. Re-read [`plan.md`](plan.md) §6.1.1 ("SDK behavior audit") against the
   new version's source.
2. If the SDK now exposes `marker` persistence, native Retry-After
   handling, or `AbortSignal` wiring, file an issue to consider retiring
   parts of our supervisor.
3. Bump the pin in a dedicated PR; do not couple it with an upstream sync.

## §10 When to skip sync

Routine syncs are cheap, but they are not free. Acceptable cases for
delaying:

- **Patch-only release** (e.g. `vXXXX.Y.Z-1` style hotfix) that touches
  surfaces unrelated to channels (model providers, agent harness, sandbox,
  Control UI). Skim the release notes; if `extensions/max-messenger/`'s
  imports aren't anywhere near the change, skip until the next minor.
- **Active phase work in progress** — if Phase X.Y is mid-flight and the
  sync would force you to retest 66 cases in the middle of a feature
  branch, defer the sync 1-2 weeks. The supervisor's worst case (running
  on a 2-3 week stale openclaw) is bounded by the SDK's own backwards
  compatibility guarantees.
- **Upstream cycle is mid-release** — if upstream just started a `-beta.N`
  cycle and you can see the release notes are still churning, wait for
  the stable cut.

Cases where you should **not** skip:

- A sync is ≥3 weeks behind. SDK drift compounds; deferred syncs are
  exponentially harder than incremental ones.
- A new bundled plugin lands upstream that touches the same SDK surfaces
  we use (per the §3 table in [`upstream-sync-post-phase-1b.md`](upstream-sync-post-phase-1b.md)).
  The risk of API drift is concentrated there.
- A `2026.X.Y` minor bump (not just patch) — these tend to carry
  meaningful core changes even when our plugin's surface seems untouched.

When in doubt, prefer to sync. The conflict pattern is well-understood
and the verification suite catches regressions before they ever reach
`main`.
