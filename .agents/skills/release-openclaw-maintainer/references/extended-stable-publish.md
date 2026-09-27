# Extended-stable publication

When asked to create the initial `.33` extended-stable line or a later
maintenance patch, read
`backport-discovery.md` and
`extended-stable-backports.md` and follow both before version, tag,
or publication work. Treat backport discovery and preparation as an ability of
this release skill, not as a separate release workflow.

The backport flow covers mainline inventory, private-security reconciliation,
approval, the staging PR, and proof handoff. After it lands, use the shared
release pipeline with the extended-stable track inputs below.

Extended-stable requires a visible **SDK/config backport warning** whenever a
candidate changes the public plugin SDK or a config/default/schema/migration
surface. Prefer an adaptation that uses the SDK and configuration already
shipped on that line. If a contract change remains necessary, record its
published impact and the maintainer decision in the ledger and staging PR.
Read `extended-stable-backports.md`; a clean cherry-pick, green
release checks, or a regenerated baseline does not by itself explain the
maintenance risk.

Use this path only for a `.33+` Gateway distribution from either of the two
trailing completed months: the `openclaw` npm package, official npm plugins,
and matching Docker Gateway images. Use
`scripts/openclaw-npm-extended-stable-release.mjs` and the release workflows
on pinned current `main` for command and validation requirements.

1. On `extended-stable/YYYY.M.33`, verify the root and every publishable official
   plugin have the intended version. Generate and commit the complete
   `CHANGELOG/YYYY.M.P.md` entry with `### Highlights`, `### Changes`, and
   `### Fixes`. Carry the full current-main Docker
   release-channel unit: workflow, promoter, policy, shared classifier, tests,
   and workflow validation. Run focused checks and freeze the untagged tip SHA.
2. Keep the frozen SHA and canonical branch as the validation target; Full
   Release Validation derives `npm_dist_tag=extended-stable` from the version.
3. Run complete Full Release Validation against the canonical branch with
   `release_profile=stable`; save its run ID and successful `run_attempt`.
   Use the trusted main-pinned helper's canonical `release-ci/*` producer,
   which attests the immutable target SHA in its manifest. Direct branch/main
   producers do not satisfy protected-tag shared publication. Current manifests
   include qualified npm and prepared Docker artifacts; use that same run ID
   and attempt for npm preflight publication evidence. Also run the supplemental
   trusted-main preflight described in `release-openclaw-ci`; that validation-only
   run does not replace the integrated publication artifact. Any candidate
   branch change invalidates both gates.
4. Require the tip still equals the frozen SHA, then create signed `vYYYY.M.P`.
   Never move or delete a final tag; later source changes need a new patch.
5. Require the saved validation run to be complete and successful, bind its
   manifest target SHA and attempt to the tag, and require the canonical
   `release-ci/<sha12>-<epoch>` producer with trusted tooling identity. Reject
   direct canonical-branch/main producers and narrow reruns.
6. With publication/tag-push authority, create and push a protected lightweight
   `release-publish/<tooling-sha12>-<epoch>` tag at the frozen trusted-main
   Tooling SHA: `git tag "$PUBLISH_REF" "$TOOLING_SHA"`, then
   `git push origin "refs/tags/$PUBLISH_REF"`. Set `PUBLISH_REF` to the chosen
   protected tag name before running these commands. Dispatch
   `OpenClaw Release Publish` with `--ref` set to that tooling tag, the product
   release tag as `tag`, `npm_dist_tag=extended-stable`,
   `publish_openclaw_npm=true`, the saved
   preflight and Full Release Validation run IDs, and the saved validation run
   attempt. The parent derives `release_candidate_branch`, creates the draft,
   publishes every official npm plugin and core under `extended-stable`,
   attaches release evidence, skips ClawHub/native publication, publishes
   Docker, and finalizes the release with `latest=false`.
7. If core npm already published, resume the parent from the same protected
   tooling tag with `openclaw_npm_resume_run_id` bound to the successful original core publish.
   It verifies the registry tarball against preflight before resuming evidence,
   Docker, and finalization. Docker-only recovery may dispatch from `main` with
   `publish_openclaw_npm=false` and `publish_docker_only=true`; that path does
   not attach evidence or finalize the release.
8. Set `TARGET_ROOT` to the absolute path of the unchanged, qualified checkout
   and `TARGET_SHA` to the recorded full product Release SHA, not the tooling SHA.
   From a clean, qualified current-`main` tooling checkout, run
   `node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.P "$TARGET_ROOT" "$TARGET_SHA"`.
   Verify package signatures, source commits, inventories, exact versions, and selectors.
   To promote an already-published core version to `extended-stable`, use
   `promote_extended_stable` in the `openclaw/releases` dist-tag workflow
   from that repository's `main`. Follow
   [registry selector recovery](publication-recovery.md#registry-selectors),
   not the publication/resume path. The target must be a final extended-stable
   version with patch `33` or higher and no suffix; fixes increment the patch.
   Stable/beta promotion and sync reject that
   patch range. The same action can select an older extended-stable version
   for rollback. Repair other selectors separately with
   approved credential-isolated tooling. Never republish a version.
9. Require `Docker Release` to verify default, slim, browser, and architecture
   images in GHCR and Docker Hub, including attestations and platform versions.
   It must advance only
   `extended-stable`, `extended-stable-slim`, and `extended-stable-browser` by
   digest and refuse automatic rollback. For alias repair, dispatch the
   approval-gated `docker-channel-promote.yml` from current `main` with the exact
   tag; never rebuild or move the release tag.
10. Verify the non-Latest GitHub Release and its dependency, validation, and
    postpublish evidence. Do not publish macOS, Windows, mobile, website,
    ClawHub, regular npm `latest`, or private dist-tag artifacts from this path.

## Trusted-main npm recovery

Use this route when the frozen candidate's publishing tooling is the failure,
for example an obsolete check rejecting validated dependency pins because npm
`latest` advanced. Keep the candidate and its successful qualification unchanged.
A product defect, known vulnerable dependency, or changed candidate needs its
own repair and fresh qualification; workflow recovery does not waive those gates.

Use this lower-level route only for an approved workflow recovery, not normal
shared publication. It does not itself attach evidence or finalize the GitHub
Release. Retain both child identities and their evidence for approved closeout;
an independently dispatched recovery run is not automatically interchangeable with the
protected parent's core-resume receipt.

Mint or reuse a protected `release-publish/<tooling-sha12>-<epoch>` tag at the
frozen trusted-main Tooling SHA as above. In `gh workflow run`, `--ref` selects
that publishing **tooling** tag.
The plugin input `-f ref=<release-sha>` selects the exact **package source**;
never replace it with `main`, a branch name, or the tooling SHA.

After the publication prerequisites above pass, dispatch:

```bash
gh workflow run plugin-npm-release.yml --repo openclaw/openclaw \
  --ref release-publish/<tooling-sha12>-<epoch> \
  -f publish_scope=all-publishable \
  -f ref=<exact-40-character-release-sha> \
  -f npm_dist_tag=extended-stable \
  -f release_candidate_branch=extended-stable/YYYY.M.33
```

Leave `plugins` empty and `preflight_only=false` (the default). A successful
artifact or trusted-publisher preflight is not a successful publication run.
The source must still equal the canonical `extended-stable/YYYY.M.33` tip;
the workflow rechecks that tip immediately before each OIDC npm publish after
the environment approval. Branch movement requires reassessing the candidate
and replacing its qualification, not substituting a new SHA into old evidence.
Keep final tags immutable and use a new patch for source changes after tagging.

Save the successful plugin publication run ID after exact-version and selector
readback. Dispatch `openclaw-npm-release.yml` with the same `--ref release-publish/...` and the existing
core recovery inputs:

- `tag=vYYYY.M.P`, `preflight_only=false`, and `npm_dist_tag=extended-stable`.
- `release_candidate_branch=extended-stable/YYYY.M.33`, including for patches
  above `.33`; this is a core input, not a plugin input.
- `plugin_npm_run_id=<successful-plugin-publication-run-id>` from this recovery.
- Preserve `preflight_run_id`, `full_release_validation_run_id`, and
  `full_release_validation_run_attempt` for the unchanged candidate. Current
  qualified manifests supply both run IDs from the same successful validation.

Core verifies the plugin workflow's identity, trusted-main ancestry, and exact
candidate binding. Record both workflows' actual tooling SHAs and run IDs in
the release handoff. Each direct human dispatch requires its `npm-release`
approval job before publishing in `npm-publish`. Immutable artifact checks,
and registry readback still apply; extended-stable token bootstrap is prohibited.
Reuse already-published versions and verified bytes. If only core failed, retain
the successful plugin run instead of dispatching plugin publication again.
