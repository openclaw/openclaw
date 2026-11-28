## Regular beta/stable checks

Use these checks only for the regular orchestrated release track.

1. GitHub release:
   - `gh release view v<VERSION> --repo openclaw/openclaw --json tagName,name,publishedAt,isDraft,isPrerelease,targetCommitish,url,body,assets`
   - Confirm stable releases are not draft/prerelease.
   - Confirm release body has npm, CI, plugin npm, ClawHub, mac/appcast evidence
     links when expected.
   - Confirm assets expected for stable mac releases are uploaded: zip, dmg,
     dSYM, dependency evidence, immutable full-validation manifest,
     postpublish evidence, and stable-main closeout manifest.
   - Download each immutable evidence asset and its `.sha256` companion, then
     verify the checksum before trusting the release record.
2. Root npm:
   - `npm view openclaw@<VERSION> version dist-tags.latest dist.tarball dist.integrity time.<VERSION> --json`
   - `latest` must equal `<VERSION>` for stable.
   - Record tarball, integrity, publish time.
   - Confirm the release postpublish evidence records
     `npmRegistrySignaturesVerified: true` and
     `npmProvenanceAttestationMatched: true`.
3. Plugin publish set:
   - Get exact tag metadata from GitHub, not the local checkout when dirty:
     download `https://api.github.com/repos/openclaw/openclaw/tarball/v<VERSION>`
     into `/tmp/openclaw-v<VERSION>-src`.
   - Derive the full expected npm and ClawHub package sets for the release track
     with the canonical publication planners/collector from the recorded release
     Tooling SHA, using the exact tag's package metadata.
     Do not count raw publish flags: `openclaw.build.bundledDist === true`
     explicitly defers external publication even when publish flags are set.
     Record deferred package names and reasons separately.
   - Reconcile expected package identities, versions, and counts across original
     publication, previously published versions, and selected recovery runs using
     immutable publication plans, registry readback, and workflow jobs. A selected
     recovery subset must not narrow the full expected release set:
     `gh api repos/openclaw/openclaw/actions/runs/<RUN>/jobs --paginate`.
   - For each expected npm plugin, verify the planned version and npm selector
     from that immutable publication plan. A regular beta publishes to `beta`;
     do not require it to move `latest`. Verify any planned mirror tags separately.
4. ClawHub (independent status, not a core or closeout gate):
   - Check the Plugin ClawHub Release workflow conclusion and publish job count.
     If pending or failed, record that state and its follow-up separately;
     continue core verification and closeout without waiting.
   - Use OpenClaw itself for live registry proof:
     `openclaw plugins search <known-plugin> --json`.
   - Install one official plugin at the exact requested release version from
     ClawHub in an isolated HOME:
     `openclaw plugins install clawhub:@openclaw/matrix@<VERSION>`.
     Prefer `matrix` unless that plugin is not in the expected set. ClawHub
     versions belong in the spec; `--pin` is only supported for npm installs.
5. Release workflows:
   - Verify conclusions for release notes evidence links:
     Full Release Validation, OpenClaw Release Checks, OpenClaw NPM Release,
     Plugin NPM Release, mac preflight/validation/publish when stable mac assets
     are expected. Report Plugin ClawHub Release independently, even when its
     result is still pending or failed.
   - For stable, verify `OpenClaw Stable Main Closeout` succeeded and its
     manifest records the matching release tag, current rollback drill, stable
     soak, and blocking performance evidence.
   - Summarize only relevant successful/failed jobs; ignore routine skipped
     optional lanes unless the release body promised them.
6. Container registries:
   - Resolve `VERCEL_VCR_IMAGE` from the repository variable and use the
     trusted tooling checkout to run `scripts/container-registry-readback.mjs`
     with the exact version, both `ghcr.io/openclaw/openclaw` and
     `docker.io/openclaw/openclaw`, and the Vercel image. Pass
     `--include-browser` when the release Dockerfile includes that variant.
   - Require every default, slim, browser, amd64, and arm64 immutable tag in all
     three registries, matching cross-registry platform descriptors, and every
     policy-owned moving alias at the immutable digest and descriptor set.
     Beta intentionally has zero moving aliases; do not require a `beta`
     container alias.
   - Use existing Docker credential state for private Vercel reads. If it is
     unavailable, report Vercel live readback as a gap rather than treating the
     workflow conclusion as equivalent proof.
