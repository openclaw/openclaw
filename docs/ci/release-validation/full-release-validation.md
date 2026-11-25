---
summary: "The Full Release Validation umbrella, release publish, and Docker Release dispatch"
read_when:
  - You are dispatching or rerunning Full Release Validation
  - You are publishing a release or a Docker image
title: "Full Release Validation"
sidebarTitle: "Full Release Validation"
doc-schema-version: 1
---

Validate an exact candidate, then publish its qualified artifacts. Part of [Release validation workflows](/ci/release-validation).

## Mobile store releases

- Run `iOS Store Release` (`ios-store-release.yml`) or `Android Store Release` (`android-store-release.yml`) on `main` with defaults. iOS also offers `screenshots` without upload. Each platform queues uploads without cancelling active ones.
- Local equivalents, from clean current `main`: `pnpm ios:release:upload` / `pnpm android:release:upload`. Both freeze source, plan from repository versions/store state, generate notes, build, sign, and upload.
- Set `OPENAI_API_KEY` locally; Actions uses the same-named secret. See each app's `fastlane/SETUP.md` for platform/signing/store credentials.
- Preparation changes no tracked files and creates no commits/PRs. Upload records bind the original SHA under `refs/openclaw/mobile-releases/`. Actions keeps plans, `release-notes.json`, and available signed binaries for 30 days.
- After failure, inspect artifacts and store state before another upload. App Review submission and Android production promotion remain manual.

Preview notes without building/uploading:

```bash
pnpm mobile:release:notes -- generate --platform ios --plan /path/to/ios-plan.json --output /path/to/preview-notes.json
```

- Android: use `--platform android` and `android-plan.json` for phone/Wear. Plans bind version/build, source SHA, and public baseline builds. Historical candidates need matching `--source-sha <full-commit-sha>` available locally.
- Existing output is validated/reused without a model call; use a new output path for another draft.
- Generation uses OpenAI Responses structured output, source extraction, and separate factual review; covers app/shared code, Play sources, and Watch RTC. Notes must fit store limits; generation/review failure stops upload.
- Inspect saved notes before public promotion: models can miss changes. Reproduce notes by retaining artifacts, not rerunning the model.

## Full Release Validation

### Choose and freeze the run

- Bind candidate **C**, qualification **Q**, and admission/publication **P**. `expected_sha` mismatch fails before child dispatch. Q=C by default; the candidate route can admit a reviewed main-ancestor Q against unchanged C. P owns authority/verification, not substitute tests.
- Validation SHA means Code SHA for product validation or Release SHA for changelog-only validation—not another identity.
- Profiles: `beta` = fastest OpenAI/core lanes, normally `run_release_soak=false`; `stable` = regular stable provider/backend set; `full` = broad provider/media matrix. Manual workflows default to stable. Stable/full always run exhaustive live/E2E and Docker release-path soak; beta opts in with `run_release_soak=true`.
- See the [reference](/reference/full-release-validation) for stages, job names, `npm-beta-v1` / `npm-stable-v1` coverage, artifacts, and rerun handles.

### Coverage and runners

| Surface                                | Contract                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normal_ci`                            | Exact target/release scope through `ci.yml`, without `release_gate`. Every selected failure blocks, including Windows Node. Typechecks use `OPENCLAW_TYPECHECKER=tsgo`; PR/main CI use tsrs.                                                                                                                                                                                                                   |
| Complete campaigns (`rerun_group=all`) | Full QA Smoke and Control UI performance regardless of changed paths. Hosted manual QA Smoke uses six parts; normal hybrid first attempts use four, with equal coverage.                                                                                                                                                                                                                                       |
| Docker seed                            | All ordinary manual/release scopes, including npm-beta/npm-stable: `cron-mcp-cleanup`, `mcp-channels`, `mcp-code-mode-gateway`, `published-upgrade-survivor`, `update-channel-switch`.                                                                                                                                                                                                                         |
| Survivor                               | `legacy-operator-state` + `auto-auth`: published driver updates the running managed Gateway. Required on admitted upstream main and frozen targets declaring support. Historical/missing catalogs use `base` + `auto-auth`; invalid catalogs fail. Targets without the tier selector retain survivor fallback.                                                                                                 |
| Automatic PR coverage                  | Complete survivor deferred to hourly main/FRV; other Docker lanes and QA Smoke retain owner maps. Regressions outside automatic owner paths or in release-only lanes may first surface here.                                                                                                                                                                                                                   |
| Packages                               | Ordinary manual CI builds full declarations. FRV Docker seed uses existing smoke package and 16-class Blacksmith when no release runner group is configured; coverage unchanged. Main/selected PRs (including exact-head release gates) use `ciArtifacts` + shared `--skip-build` packer, retaining runtime, public SDK declarations, and integrity checks. Hourly protected warmer retains full declarations. |
| Runtime selection                      | [Capable targets](/ci/pipeline#test-runtime-selection) run complete Node inventory plus admitted Bun selections sequentially per worker; both must pass. This includes full Control UI/retention assertions when admitted. Older targets retain Node and only their admitted Bun/UI selections.                                                                                                                |
| Package Acceptance                     | Expanded published-upgrade scenarios; unpublished candidates include native operator state; stable/full force `reported-issues` soak. Ordinary survivor restart and `update-restart-auth` base do not replace Docker seed proof.                                                                                                                                                                               |
| Immutable inputs                       | `Full Release Artifacts` / `Full Release Candidate` prepare package/images; candidate checks consume them without reducing coverage. Release Checks resolves one `release-package-under-test` tarball for cross-OS, Package Acceptance, and soak Docker consumers; preparation budget: 35 minutes.                                                                                                             |
| Codex live plugin                      | Use matching published spec from `release_package_spec`, explicit `codex_plugin_spec`, or blank to pack the selected checkout's plugin.                                                                                                                                                                                                                                                                        |
| Historical harnesses                   | Docker seed needs its declared capability; QA Smoke needs supported harness; historical performance retains availability handling. Narrow groups and verified reuse retain their contracts.                                                                                                                                                                                                                    |
| Metadata validation                    | Live/E2E selected-ref job fetches full ref/commit history sparsely; ancestry/release-ref checks unchanged. Build/test jobs check out full source.                                                                                                                                                                                                                                                              |
| Runner placement                       | Upstream hybrid target resolution, evidence reuse, candidate discovery/binding/resolution use small Blacksmith. Other repositories/modes use hosted runners; explicit hosted override is honored. Long decision/diagnostic collectors stay hosted. Outage/retry routes and serial weighted lane admission remain unchanged.                                                                                    |

### Publish qualified artifacts

1. After the release tag and successful npm preflight (including `pnpm plugins:sync:check`), dispatch `OpenClaw Release Publish` from protected lightweight `release-publish/<tooling-sha12>-<epoch>` at frozen Tooling SHA. The release tag selects the exact release commit, including `release/YYYY.M.PATCH`.
2. Set `preflight_run_id` and `full_release_validation_run_id` to the same successful FRV run; pin `full_release_validation_run_attempt`. The sealed `publicationArtifacts.npmPreflight` descriptor identifies the independent artifact producer; producer ID alone is not authorization.
3. Historical recovery may use separate successful `OpenClaw NPM Release` preflight plus matching FRV run/attempt. See [tooling-tag commands](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md#qualify-publication-bytes). Real core/plugin npm or ClawHub publication from `main` is rejected before children; Docker-only recovery may use main.
4. Publisher dispatches all publishable `Plugin NPM Release` packages and same-SHA `Plugin ClawHub Release`, then `OpenClaw NPM Release` after plugin npm succeeds. Focused repairs use `plugin_publish_scope=selected` plus nonempty list; plugin-only `all-publishable` needs the same immutable npm/FRV evidence as core.

```bash
PUBLISH_REF="release-publish/<tooling-sha12>-<epoch>"
FRV_RUN_ID="<successful-full-release-validation-run-id>"
FRV_RUN_ATTEMPT="<successful-full-release-validation-run-attempt>"
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_attempt="$FRV_RUN_ATTEMPT" \
  -f npm_dist_tag=beta
```

**Docker:** after source/image preparation (or supplied prepared artifacts), a separate job requests `docker-release` environment approval. Only the approved publisher enters the global `docker-release-publish` registry/alias lock, then revalidates source, artifacts, attestations, and aliases before writes. Caller supplies Docker Hub secrets. Failed preparation, denied approval, or cancellation cannot publish.

**Native publication:**

- Windows is optional: provide both exact `windows_node_tag` and candidate-approved `windows_node_installer_digests` for signed installers after GitHub release finalization; omit both to skip.
- Legacy npm-stable Android: matching tagged `apps/android/version.json` and stable base version starts separate exact-release-SHA full CI with Android. Revalidate success after core publication before creating the existing approval receipt and dispatching tag-owned APK.
- Native failure blocks Android approval, not core npm/GitHub finalization; the parent may remain active afterward. Existing full evidence and independent macOS qualification are unchanged.
- Current source has no Android version manifest, so Gateway publication skips Android; current Android releases use the independent Play workflow. Legacy tagged-source recovery retains its eligibility, qualification, protected approval, signing, and verification requirements. A mismatched legacy pin skips qualification/APK.

### Dispatch and recover

For exact proof on moving branches, use the helper rather than `gh workflow run ... --ref main -f ref=<sha>`:

```bash
PUBLISHER_SHA="<recorded-full-trusted-main-ancestor-sha>"
VALIDATION_SHA="<full-release-candidate-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref release/YYYY.M.PATCH \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  --request-file <private-request-file> \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

- On main, `--admission-workflow-sha` is a reviewed ancestry anchor and may advance to a verified descendant. Add `--pin-admission-workflow` to freeze it; protected `release-publish/*` admission refs are always pinned.
- Beta: `npmDistTag=beta`. Use `route=prepared` only for prepared-button consumers. Source admission verifies committed metadata; fresh publishes also require selected npm/ClawHub registry admission before fanout. Neither grants publication authority. See [Dispatch](/reference/full-release-validation/dispatch).
- Nonpublish: explicitly select `diagnostic`, `main-qualification`, or `postpublish-confidence`; omit publication selection. Profiles/filters still determine coverage.
- GitHub dispatch refs must be branches/tags, not raw SHAs. Even dry runs prove bare-SHA fetchability in a fresh repository. Admission then creates immutable `release-ci/*` at Q and passes C in `ref`/`expected_sha`. New child `headSha` must equal Q; reused evidence retains original Q/coverage. Record C/Q/P; never refresh Q from moving main. Regular release branches accept their final package version or matching beta.
- `fail_fast=false` gathers independent child failures. `true` cancels a child after its first failed job and enables Release Checks Matrix QA first-scenario cancellation. `Verify full validation` checks recorded child IDs within that parent attempt. Parent cancellation/timeout leaves adopted children running; cancel unneeded children explicitly.
- Classify every failure as blocker/flake and product, harness/tooling/provenance, infrastructure/credential, or wrapper before editing. Only confirmed product failures require changing C. [Q-only recovery](/reference/full-release-validation/dispatch#recover-qualification-tooling-without-changing-the-candidate) needs new admission and successful parent.
- Fix the owner before explicit narrow `rerun_group`; no automatic failed-test retry or widening to all. Flakes: at most two explicit same-SHA reruns plus tracked main fix; record eligible persistent failure instead of changing tooling, recutting, or another FRV. Narrow evidence alone cannot authorize publication.
- Concurrency: Validation SHA + Tooling SHA + rerun group + profile + effective soak; `cancel-in-progress: false`. Release Checks uses the same coverage identity per phase, so profiles do not queue behind each other. Explicit stable/full soak flags do not create another group.
