import { execFileSync } from "node:child_process";
import {
  loadReleaseNotesForTag,
  renderGithubReleaseNotes,
  verifyGithubReleaseNotes,
} from "../render-github-release-notes.mts";
import { isRecord, trimString } from "./record-shared.mjs";
import { loadReleaseChangelog } from "./release-changelog.mjs";
import { evaluateStableRollbackDrill, type ReleasePublishGate } from "./release-publish-gates.mts";
import {
  preflightApi,
  readPublishPreflightRelease,
  requirePreflightRecord,
  type PublishPreflightGh,
} from "./release-publish-preflight-evidence.mts";
import { verifyStableMainCloseout } from "./stable-release-closeout.mjs";

export function inspectPublishReleasePage(input: {
  repo: string;
  tag: string;
  sourceSha: string;
  runGh: PublishPreflightGh;
}) {
  // Initial publication always renders the frozen notes, including when no
  // release page exists yet. Check this before the expensive child dispatches.
  const notes = loadReleaseNotesForTag({
    rootDir: process.cwd(),
    ref: input.sourceSha,
    tag: input.tag,
  });
  renderGithubReleaseNotes({
    changelog: notes.section,
    version: notes.version,
    tag: input.tag,
    repository: input.repo,
    contributionRecordPath: notes.recordPath ?? undefined,
  });
  const lookup = readPublishPreflightRelease(input.runGh, input.repo, input.tag);
  if (lookup.state !== "found") {
    return undefined;
  }
  const release = lookup.release;
  // The publisher's gh release view turns a nullable REST body into an empty string.
  const body = release.body ?? "";
  if (typeof body !== "string") {
    throw new Error("Existing release body is missing.");
  }
  if (body.includes("<!-- openclaw-release-publication:docs-v1 -->")) {
    throw new Error(
      "The release already belongs to the docs-publication owner; the initial publisher must not overwrite it.",
    );
  }
  if (!release.draft) {
    const canonical = verifyGithubReleaseNotes({
      body,
      changelog: notes.section,
      version: notes.version,
      tag: input.tag,
      repository: input.repo,
      contributionRecordPath: notes.recordPath ?? undefined,
    });
    const assets = Array.isArray(release.assets) ? release.assets.filter(isRecord) : [];
    const hasAsset = assets.some(
      (asset) => asset.name === `openclaw-${input.tag.slice(1)}-dependency-evidence.zip`,
    );
    const hasProof = body.includes("### Release verification");
    if (!canonical.matches || !hasAsset || (hasProof && !body.includes(input.sourceSha))) {
      throw new Error(
        "Public release has incomplete or noncanonical postpublish evidence for this exact source. Reconcile that release before retrying the initial publisher.",
      );
    }
  }
  return release;
}

export function inspectStableCloseoutPreflight(input: {
  repo: string;
  tag: string;
  sourceSha: string;
  attempt: string;
  runId: string;
  runGh: PublishPreflightGh;
}): ReleasePublishGate[] {
  const rows: ReleasePublishGate[] = [];
  const api = (endpoint: string) => preflightApi(input.runGh, input.repo, endpoint);
  const add = (
    id: string,
    status: ReleasePublishGate["status"],
    message: string,
    remediation = "",
  ) => rows.push({ id: `stable-closeout.${id}`, status, message, remediation });
  let drillId = "",
    drillDate = "";
  try {
    drillId = trimString(
      requirePreflightRecord(
        api("actions/variables/RELEASE_ROLLBACK_DRILL_ID"),
        "rollback drill id",
      ).value ?? "",
    );
    drillDate = trimString(
      requirePreflightRecord(
        api("actions/variables/RELEASE_ROLLBACK_DRILL_DATE"),
        "rollback drill date",
      ).value ?? "",
    );
    rows.push(
      ...evaluateStableRollbackDrill({
        rollbackDrillId: drillId,
        rollbackDrillDate: drillDate,
        nowMs: Date.now(),
      }),
    );
  } catch (error) {
    add(
      "rollback-variables",
      "FAIL",
      error instanceof Error ? error.message : String(error),
      "Record RELEASE_ROLLBACK_DRILL_ID and RELEASE_ROLLBACK_DRILL_DATE after the approved rollback drill, or use closeout's explicit manual override.",
    );
  }
  try {
    const mainSha = String(
      requirePreflightRecord(
        requirePreflightRecord(api("git/ref/heads/main"), "main").object,
        "main commit",
      ).sha,
    );
    if (!/^[a-f0-9]{40}$/u.test(mainSha)) {
      throw new Error("Invalid main SHA.");
    }
    const git = (ref: string, file: string) =>
      execFileSync("git", ["show", `${ref}:${file}`], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      });
    const tagPackageJson = requirePreflightRecord(
      JSON.parse(git(input.sourceSha, "package.json")),
      "release package",
    );
    const mainPackageJson = requirePreflightRecord(
      JSON.parse(git(mainSha, "package.json")),
      "main package",
    );
    const version = String(tagPackageJson.version);
    const mainRelease = loadReleaseChangelog({ rootDir: process.cwd(), ref: mainSha, version });
    const tagRelease = loadReleaseChangelog({
      rootDir: process.cwd(),
      ref: input.sourceSha,
      version,
    });
    const lookup = readPublishPreflightRelease(input.runGh, input.repo, input.tag);
    if (lookup.state === "unresolved") {
      add(
        "release-state",
        "WARN",
        lookup.message,
        "Inspect the release with credentials that can view drafts before stable closeout.",
      );
    }
    const release =
      lookup.state === "found"
        ? {
            ...lookup.release,
            tagName: lookup.release.tag_name,
            isDraft: lookup.release.draft,
            isPrerelease: lookup.release.prerelease,
          }
        : undefined;
    const result = verifyStableMainCloseout({
      tag: input.tag,
      mainPackageJson,
      tagPackageJson,
      mainRelease,
      tagRelease,
      mainAppcast: git(mainSha, "appcast.xml"),
      release,
      releaseTagSha: input.sourceSha,
      mainSha,
      fullReleaseValidationRunId: input.runId,
      fullReleaseValidationRunAttempt: input.attempt,
      releasePublishRunId: "",
      rollbackDrillId: drillId,
      rollbackDrillDate: drillDate,
      nowMs: Date.now(),
    });
    const sourceErrors = result.errors.filter((reason: string) =>
      /^(?:main (?:package\.json|CHANGELOG\.md|changelog)|release tag package\.json)/u.test(reason),
    );
    // Main absorbs the shipped version/changelog after publication. Readiness
    // is advisory here; making it a publish prerequisite would deadlock the release.
    add(
      "main-source",
      sourceErrors.length ? "WARN" : "PASS",
      sourceErrors.join(" ") ||
        `Main ${mainSha} has compatible version and exact shipped changelog accounting.`,
      sourceErrors.length
        ? "Reconcile the shipped version and changelog onto main before stable closeout; preserve the frozen contribution record."
        : "",
    );
    for (const error of result.errors.filter(
      (reason: string) => !sourceErrors.includes(reason) && !reason.startsWith("rollback drill"),
    )) {
      add(
        "release-assets",
        "WARN",
        error,
        "Complete publication and run the canonical Stable Main Closeout owner to verify the actual release assets, appcast and Linux selectors.",
      );
    }
  } catch (error) {
    add(
      "main-source",
      "WARN",
      error instanceof Error ? error.message : String(error),
      "Make the exact current main and release commits available with git fetch --no-tags origin main; reconcile the release version/changelog before closeout.",
    );
  }
  for (const [id, message, remediation] of [
    [
      "publish-receipt",
      "The future Release Publish parent/attempt and successful core/Docker jobs cannot be proved before dispatch.",
      "Closeout requires the exact successful publisher, or its supported failed-parent recovery with successful npm and Docker jobs.",
    ],
    [
      "immutable-receipt",
      "Any existing checksummed closeout manifest and later release assets need final readback after publication.",
      "The closeout owner verifies the manifest checksum, immutable asset inventory, allowed late assets, appcast, and exact Linux updater selectors.",
    ],
  ]) {
    add(id!, "WARN", message!, remediation!);
  }
  return rows;
}
