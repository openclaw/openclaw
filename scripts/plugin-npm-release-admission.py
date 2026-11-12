import json
import os
import re
import sys

from ci_git_owner import GitFailure, git_output, run_git

workspace = os.environ["GITHUB_WORKSPACE"]

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def exact_ref_match(left_ref, right_ref):
    try:
        left = git_output(workspace, "rev-parse", left_ref).rstrip("\n")
        right = git_output(workspace, "rev-parse", right_ref).rstrip("\n")
    except GitFailure:
        return False
    return left == right

def is_ancestor(ref, source="HEAD"):
    try:
        run_git(workspace, "merge-base", "--is-ancestor", source, ref)
        return True
    except GitFailure as error:
        if error.code == 1:
            return False
        raise

def require_current_main_tooling(message):
    run_git(
        workspace,
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        timeout=120,
        reclaim_locks=True,
    )
    if not is_ancestor("origin/main", os.environ["WORKFLOW_SHA"]):
        fail(message)

preflight = os.environ["PREFLIGHT_ONLY"] == "true"
if os.environ["REQUIRE_NPM_PUBLISH_ENVIRONMENT"] == "true":
    tooling_tag = re.fullmatch(
        r"refs/tags/release-publish/([a-f0-9]{12})-[1-9][0-9]*",
        os.environ["WORKFLOW_REF"],
    )
    if tooling_tag is None:
        fail(
            "Real npm publication and trusted-publisher preflight require a protected "
            "release-publish/<sha12>-<n> tooling tag. Mint one with pnpm "
            "release:publish-preflight / ensureReleasePublishToolingTag, then dispatch "
            "with --ref release-publish/...."
        )
    if not os.environ["WORKFLOW_SHA"].startswith(tooling_tag.group(1)):
        fail("Protected release-publish tag does not match the plugin npm workflow SHA.")
if os.environ["PREPARED_ARTIFACT"] and preflight:
    fail("Prepared npm artifacts are publication inputs, not preflight inputs.")
if os.environ["TRUSTED_PUBLISHER_PREFLIGHT"] == "true" and not preflight:
    fail("trusted_publisher_preflight requires preflight_only=true.")
source_ref = os.environ["SOURCE_REF"]
if os.environ["PREPARED_ARTIFACT"] and not re.fullmatch(r"[0-9a-f]{40}", source_ref):
    fail("Prepared npm publication requires the exact source SHA.")
run_id = os.environ["RELEASE_PUBLISH_RUN_ID"]
run_attempt = os.environ["RELEASE_PUBLISH_RUN_ATTEMPT"]
candidate_branch = os.environ["RELEASE_CANDIDATE_BRANCH"]
if preflight:
    if not re.fullmatch(r"[0-9a-fA-F]{40}", source_ref) or not exact_ref_match(
        "HEAD",
        f"{source_ref}^{{commit}}",
    ):
        fail("Plugin npm preflight requires ref to be the exact 40-character source SHA.")
    if run_id.strip() or run_attempt.strip():
        fail("Plugin npm preflight must not include a release publish parent run tuple.")
    if candidate_branch.strip():
        fail("Plugin npm preflight must not include release_candidate_branch.")
if os.environ["TRUSTED_PUBLISHER_PREFLIGHT"] == "true":
    if os.environ["NPM_DIST_TAG"] != "extended-stable" and (
        os.environ["PUBLISH_SCOPE"] != "selected"
        or not os.environ["RELEASE_PLUGINS"].strip()
    ):
        fail(
            "Regular trusted-publisher preflight requires publish_scope=selected "
            "with an explicit plugin list."
        )
    require_current_main_tooling(
        "Trusted-publisher preflight tooling revision is not reachable from current main."
    )
if run_id.strip() and not re.fullmatch(r"[1-9][0-9]*", run_attempt):
    fail("release_publish_run_id requires the exact positive release_publish_run_attempt.")

if os.environ["NPM_DIST_TAG"] == "extended-stable":
    if os.environ["PUBLISH_SCOPE"] != "all-publishable" or os.environ[
        "RELEASE_PLUGINS"
    ].strip():
        fail(
            "Extended-stable plugin publication requires publish_scope=all-publishable "
            "without an explicit plugin list."
        )
    if not re.fullmatch(r"[0-9a-f]{40}", source_ref) or not exact_ref_match(
        "HEAD",
        f"{source_ref}^{{commit}}",
    ):
        fail(
            "Extended-stable plugin publication requires ref to be the exact "
            "40-character source SHA."
        )
    with open(os.path.join(workspace, "package.json"), encoding="utf-8") as source:
        package_version = json.load(source).get("version")
    version = (
        re.fullmatch(r"([0-9]{4})\.([1-9]|1[0-2])\.([1-9][0-9]*)", package_version)
        if isinstance(package_version, str)
        else None
    )
    if version is None or int(version.group(3)) < 33:
        fail(
            "Extended-stable plugin publication requires a final YYYY.M.PATCH version "
            "with PATCH >= 33."
        )
    extended_branch = f"extended-stable/{version.group(1)}.{version.group(2)}.33"
    run_git(
        workspace,
        "fetch",
        "--no-tags",
        "origin",
        f"+refs/heads/{extended_branch}:refs/remotes/origin/{extended_branch}",
        timeout=120,
        reclaim_locks=True,
    )
    if candidate_branch.strip():
        if candidate_branch != extended_branch or not re.fullmatch(
            r"refs/tags/release-publish/[a-f0-9]{12}-[1-9][0-9]*",
            os.environ["WORKFLOW_REF"],
        ):
            fail(
                f"release_candidate_branch must be {extended_branch} and requires "
                "protected release-publish workflow tooling."
            )
        # The preceding identity check binds the protected tag to WORKFLOW_SHA.
        # Source and tooling ancestry are separate release admission boundaries.
        require_current_main_tooling(
            "Extended-stable plugin workflow revision is not reachable from current main."
        )
        if is_ancestor(f"refs/remotes/origin/{extended_branch}"):
            raise SystemExit(0)
        fail(f"Extended-stable plugin target must be reachable from {extended_branch}.")
    if not preflight:
        fail(f"Extended-stable plugin publication requires release_candidate_branch={extended_branch}.")
    if not exact_ref_match(
        "HEAD",
        f"refs/remotes/origin/{extended_branch}",
    ):
        fail(f"Extended-stable plugin source must equal the exact {extended_branch} branch tip.")
    if os.environ["TRUSTED_PUBLISHER_PREFLIGHT"] == "true":
        raise SystemExit(0)
    # Nonpublishing preflight accepts the canonical branch, main, or an
    # immutable release-ci transport whose pinned tooling is on main.
    workflow_ref = os.environ["WORKFLOW_REF"]
    if workflow_ref in (f"refs/heads/{extended_branch}", "refs/heads/main"):
        raise SystemExit(0)
    release_ci = re.fullmatch(
        r"refs/heads/release-ci/([a-f0-9]{12})-[0-9]+",
        workflow_ref,
    )
    if release_ci:
        workflow_sha = os.environ["WORKFLOW_SHA"]
        if not workflow_sha.startswith(release_ci.group(1)):
            fail("Extended-stable release-ci ref does not match the workflow SHA.")
        require_current_main_tooling(
            "Extended-stable release-ci workflow revision is not reachable from current main."
        )
        raise SystemExit(0)
    fail(
        f"Extended-stable plugin npm preflights must run from {extended_branch} "
        "trusted main, or a main-pinned release-ci ref, targeting the exact canonical branch tip."
    )

if candidate_branch.strip():
    fail("release_candidate_branch is only valid for extended-stable publication.")

run_git(
    workspace,
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "+refs/heads/release/*:refs/remotes/origin/release/*",
    timeout=120,
    reclaim_locks=True,
)
if is_ancestor("origin/main"):
    raise SystemExit(0)
release_refs = git_output(
    workspace,
    "for-each-ref",
    "--format=%(refname)",
    "refs/remotes/origin/release",
).splitlines()
if any(is_ancestor(ref) for ref in release_refs):
    raise SystemExit(0)
if preflight:
    fail("Plugin npm preflight target must be reachable from main or release/*.")
fail("Plugin npm publishes must target a commit reachable from main or release/*.")
