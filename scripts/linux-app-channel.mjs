#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "./lib/release-version.mjs";
import {
  resolveReleaseToolingIdentity,
  verifyReleaseToolingIdentity,
  verifyReleaseWorkflowRun,
} from "./release-tooling-identity.mjs";

const REPOSITORY = "openclaw/openclaw";
const CHANNEL = "linux-stable";
const INITIAL_BODY = "OpenClaw Linux update channel. Publication is not complete.";
const METADATA_LIMIT = 1024 * 1024;
const BUNDLE_LIMIT = 2 * 1024 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
let commandOverride;
let reportOverride;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileDigest(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) !== 0;) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function command(binary, args, timeout = 60_000) {
  if (commandOverride) {
    return commandOverride(binary, args, timeout);
  }
  return execFileSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 2 * METADATA_LIMIT,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      TAURI_SIGNING_PRIVATE_KEY: "",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    },
  });
}

function report(message) {
  (reportOverride ?? console.error)(message);
}

function authorizeWrite(mode, options) {
  const runGh = commandOverride ? (args) => command("gh", args) : undefined;
  const alphaBranch =
    mode === "finalize-core" && options["workflow-ref"].startsWith("tideclaw/alpha/");
  if (alphaBranch) {
    assert(
      options.latest === "false" && parseReleaseVersion(options.tag.slice(1))?.channel === "alpha",
      "Tideclaw branch finalization requires an alpha tag and explicit non-latest intent",
    );
    // Reuse the release owner's exact direct-branch grammar before allowing
    // the validator's live branch/SHA and publisher-attempt checks.
    resolveReleaseToolingIdentity({
      workflowContract: "2",
      workflowRef: options["workflow-ref"],
      workflowFullRef: options["workflow-full-ref"],
      workflowSha: options["tooling-sha"],
    });
  }
  verifyReleaseToolingIdentity({
    allowPrevalidatedRef: alphaBranch,
    repository: REPOSITORY,
    workflowRef: options["workflow-ref"],
    workflowFullRef: options["workflow-full-ref"],
    workflowSha: options["tooling-sha"],
    ...(runGh ? { runGh } : {}),
    ...(mode === "publish"
      ? {}
      : {
          releasePublishRunId: options["release-publish-run-id"],
          releasePublishRunAttempt: options["release-publish-run-attempt"],
          releasePublishRef: options["release-publish-ref"],
          releasePublishFullRef: options["release-publish-full-ref"],
          releasePublishParentStatePolicy: "active-or-success",
        }),
  });
  if (mode === "publish") {
    // Native builds are admitted by their successful request, not a core publisher.
    const request = JSON.parse(
      command("gh", ["api", `repos/${REPOSITORY}/actions/runs/${options["request-run-id"]}`]),
    );
    const [path, fullRef] = String(request.path ?? "").split("@", 2);
    assert(!fullRef || fullRef === "refs/heads/main", "Linux request workflow ref changed");
    assert.deepEqual(
      {
        id: request.id,
        attempt: request.run_attempt,
        repository: request.repository?.full_name,
        event: request.event,
        path,
        branch: request.head_branch,
        sha: request.head_sha,
        title: request.display_title,
        status: request.status,
        conclusion: request.conclusion,
      },
      {
        id: Number(options["request-run-id"]),
        attempt: Number(options["request-run-attempt"]),
        repository: REPOSITORY,
        event: "workflow_dispatch",
        path: ".github/workflows/linux-app-release-request.yml",
        branch: "main",
        sha: options["tooling-sha"],
        title: `Linux App Release Request [${options.tag}] desktop=${options["desktop-test"]}`,
        status: "completed",
        conclusion: "success",
      },
      "Linux release request authority changed",
    );
  }
  verifyReleaseWorkflowRun({
    repository: REPOSITORY,
    workflowRef: options["workflow-ref"],
    workflowFullRef: options["workflow-full-ref"],
    workflowSha: options["tooling-sha"],
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowPath:
      mode === "finalize-core"
        ? ".github/workflows/openclaw-release-publish.yml"
        : ".github/workflows/linux-app-release.yml",
    workflowEvent: mode === "publish" ? "workflow_run" : "workflow_dispatch",
    runStatePolicy: "active",
    ...(runGh ? { runGh } : {}),
  });
}

function regularVersion(version) {
  const parsed = parseReleaseVersion(version);
  assert(
    parsed && parsed.version === version && classifyReleaseTrain(parsed) === "stable",
    `Not a canonical regular Linux release: ${version}`,
  );
  return version;
}

function releaseVersion(tag) {
  assert(typeof tag === "string" && tag.startsWith("v"), "Expected a versioned release tag");
  return regularVersion(tag.slice(1));
}

function assetUrl(tag, name) {
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`;
}

function manifestName(version) {
  return `OpenClaw-${version}-linux.json`;
}

function bundleNames(version) {
  return {
    appimage: `OpenClaw-${version}-amd64.AppImage`,
    deb: `OpenClaw-${version}-amd64.deb`,
    desktop: [
      `OpenClaw-${version}-darwin-aarch64.dmg`,
      `OpenClaw-${version}-darwin-aarch64.app.tar.gz`,
      `OpenClaw-${version}-windows-x86_64.exe`,
    ],
    checksums: "SHA256SUMS.linux-app.txt",
  };
}

function asset(release, name) {
  const matches = release.assets.filter((entry) => entry.name === name);
  assert(matches.length <= 1, `Duplicate asset ${name} on ${release.tag_name}`);
  return matches[0];
}

function identity(release) {
  return [release.id, release.tag_name, release.draft, release.prerelease];
}

function assetIdentity(entry) {
  return (
    entry && [
      entry.id,
      entry.name,
      entry.size,
      entry.state,
      entry.digest,
      entry.browser_download_url,
    ]
  );
}

class GitHub {
  constructor(directory, mode, options) {
    this.directory = directory;
    this.sequence = 0;
    this.mode = mode;
    this.options = options;
  }

  authorize() {
    authorizeWrite(this.mode, this.options);
  }

  temp(name) {
    return join(this.directory, `${++this.sequence}-${name}`);
  }

  api(endpoint, missing = false) {
    try {
      return JSON.parse(command("gh", ["api", `repos/${REPOSITORY}/${endpoint}`]));
    } catch (error) {
      if (missing && /\bHTTP 404\b/u.test(String(error.stderr))) {
        return null;
      }
      throw error;
    }
  }

  release(tag, missing = false) {
    const release = this.api(`releases/tags/${encodeURIComponent(tag)}`, missing);
    if (!release) {
      return null;
    }
    assert(
      Number.isSafeInteger(release.id) &&
        release.id > 0 &&
        release.tag_name === tag &&
        typeof release.draft === "boolean" &&
        typeof release.prerelease === "boolean",
      "Release identity is invalid",
    );
    const assets = [];
    for (let page = 1; page <= 5; page++) {
      const rows = this.api(`releases/${release.id}/assets?per_page=100&page=${page}`);
      assert(Array.isArray(rows) && rows.length <= 100, "Invalid asset inventory");
      assets.push(...rows);
      if (rows.length < 100) {
        return { ...release, assets };
      }
    }
    throw new Error("Release asset inventory exceeds the publication bound");
  }

  latest() {
    const latest = this.api("releases/latest", true);
    if (!latest) {
      return null;
    }
    const release = this.release(latest.tag_name);
    assert.equal(release.id, latest.id, "Latest release changed during observation");
    return release;
  }

  source(tag, missing = false) {
    const ref = this.api(`git/ref/tags/${encodeURIComponent(tag)}`, missing);
    if (!ref) {
      return null;
    }
    let object = ref.object;
    for (let depth = 0; depth < 5; depth++) {
      assert(object && SHA.test(object.sha), "Invalid release tag object");
      if (object.type === "commit") {
        return object.sha;
      }
      assert.equal(object.type, "tag", "Release tag must resolve to a commit");
      object = this.api(`git/tags/${object.sha}`).object;
    }
    throw new Error("Release tag nesting exceeds the publication bound");
  }

  download(url, limit) {
    const path = this.temp("download");
    command(
      "curl",
      [
        "--disable",
        "--fail",
        "--location",
        // Revalidate cached redirects and bytes after replacing mutable manifests.
        "--header",
        "Cache-Control: no-cache",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "10",
        "--max-time",
        "90",
        "--max-filesize",
        String(limit),
        "--output",
        path,
        url,
      ],
      95_000,
    );
    const stat = lstatSync(path);
    assert(stat.isFile() && stat.size > 0 && stat.size <= limit, "Invalid public download");
    return path;
  }

  publicAsset(release, entry, limit = METADATA_LIMIT) {
    assert(
      Number.isSafeInteger(entry.id) &&
        entry.id > 0 &&
        Number.isSafeInteger(entry.size) &&
        entry.size > 0 &&
        entry.size <= limit &&
        entry.state === "uploaded",
      `Invalid asset identity: ${entry.name}`,
    );
    const url = assetUrl(release.tag_name, entry.name);
    assert.equal(entry.browser_download_url, url, "Unexpected public asset URL");
    const path = this.download(url, limit);
    assert.equal(lstatSync(path).size, entry.size, "Public asset size mismatch");
    if (entry.digest != null) {
      assert.equal(entry.digest, `sha256:${fileDigest(path)}`, "Public asset digest mismatch");
    }
    return path;
  }

  metadata(release, name) {
    const entry = asset(release, name);
    return entry ? readFileSync(this.publicAsset(release, entry)) : null;
  }

  unchanged(release, source) {
    const fresh = this.release(release.tag_name);
    assert.deepEqual(identity(fresh), identity(release), "Release identity changed before write");
    assert.equal(this.source(release.tag_name), source, "Release source changed before write");
    return fresh;
  }

  upload(release, source, name, path, mutable = false, beforeWrite = () => {}) {
    const bytesHash = fileDigest(path);
    const previous = asset(release, name);
    if (previous) {
      const old = this.publicAsset(release, previous, BUNDLE_LIMIT);
      if (fileDigest(old) === bytesHash) {
        return;
      }
      assert(mutable, `Immutable asset conflict: ${name}`);
    }
    const uploadDirectory = mkdtempSync(join(this.directory, "upload-"));
    const uploadPath = join(uploadDirectory, name);
    copyFileSync(path, uploadPath);
    const fresh = this.unchanged(release, source);
    assert.deepEqual(
      assetIdentity(asset(fresh, name)),
      assetIdentity(previous),
      `Asset changed before write: ${name}`,
    );
    beforeWrite();
    this.authorize();
    if (previous) {
      command("gh", [
        "api",
        "--method",
        "DELETE",
        `repos/${REPOSITORY}/releases/assets/${previous.id}`,
      ]);
      beforeWrite();
      this.authorize();
    }
    // No clobber/retry: uncertain replacement must be reconciled from a fresh inventory.
    command(
      "gh",
      ["release", "upload", release.tag_name, "--repo", REPOSITORY, uploadPath],
      120_000,
    );
    const published = this.unchanged(release, source);
    const uploaded = asset(published, name);
    assert(uploaded, `Upload missing from release: ${name}`);
    assert.equal(
      fileDigest(this.publicAsset(published, uploaded, BUNDLE_LIMIT)),
      bytesHash,
      `Public upload readback failed: ${name}`,
    );
  }
}

function parseManifest(bytes, publicKey) {
  assert(bytes.length <= METADATA_LIMIT, "Linux manifest is too large");
  const manifest = JSON.parse(bytes);
  const version = regularVersion(manifest.version);
  const names = bundleNames(version);
  assert.deepEqual(
    Object.keys(manifest.platforms),
    ["linux-x86_64"],
    "Linux stable currently requires exactly the admitted AMD64 platform",
  );
  const platform = manifest.platforms["linux-x86_64"];
  assert.equal(
    platform.url,
    assetUrl(`v${version}`, names.appimage),
    "Manifest bundle URL mismatch",
  );
  assert(
    typeof platform.signature === "string" &&
      platform.signature.length > 0 &&
      platform.signature.length <= 16_384,
    "Invalid manifest signature",
  );
  const proof = manifest.linuxPublication;
  assert(
    proof?.schemaVersion === 1 &&
      SHA.test(proof.sourceSha) &&
      SHA.test(proof.toolingSha) &&
      SHA.test(proof.channelSha) &&
      Number.isSafeInteger(proof.releaseId) &&
      proof.releaseId > 0,
    "Missing Linux publisher identity",
  );
  assert.equal(
    proof.publicKeySha256,
    digest(Buffer.from(publicKey, "base64")),
    "Linux publication trust root changed",
  );
  assert(
    Array.isArray(proof.assets) && [3, 6].includes(proof.assets.length),
    "Incomplete publication asset identity",
  );
  const expected = [
    names.appimage,
    names.deb,
    names.checksums,
    ...(proof.assets.length === 6 ? names.desktop : []),
  ].toSorted();
  assert.deepEqual(
    proof.assets.map((entry) => entry.name).toSorted(),
    expected,
    "Unexpected publication assets",
  );
  for (const entry of proof.assets) {
    assert(
      Number.isSafeInteger(entry.id) &&
        entry.id > 0 &&
        Number.isSafeInteger(entry.size) &&
        entry.size > 0 &&
        entry.size <= BUNDLE_LIMIT &&
        DIGEST.test(entry.sha256),
      "Invalid publication asset identity",
    );
  }
  return manifest;
}

function parseLegacyManifest(bytes) {
  const manifest = JSON.parse(bytes);
  assert.deepEqual(
    Object.keys(manifest).toSorted(),
    ["notes", "platforms", "pub_date", "version"],
    "Unrecognized legacy Linux manifest",
  );
  const version = regularVersion(manifest.version);
  assert(
    typeof manifest.notes === "string" &&
      typeof manifest.pub_date === "string" &&
      Number.isFinite(Date.parse(manifest.pub_date)),
    "Invalid legacy manifest fields",
  );
  assert.deepEqual(
    Object.keys(manifest.platforms),
    ["linux-x86_64"],
    "Unrecognized legacy Linux platforms",
  );
  const platform = manifest.platforms["linux-x86_64"];
  assert.deepEqual(
    Object.keys(platform).toSorted(),
    ["signature", "url"],
    "Unrecognized legacy Linux platform fields",
  );
  assert.equal(
    platform.url,
    assetUrl(`v${version}`, bundleNames(version).appimage),
    "Legacy Linux bundle URL mismatch",
  );
  assert(
    typeof platform.signature === "string" &&
      platform.signature.length > 0 &&
      platform.signature.length <= 16_384 &&
      /^[A-Za-z0-9+/]+={0,2}$/u.test(platform.signature),
    "Invalid legacy Linux signature encoding",
  );
  return manifest;
}

function publishedManifest(github, bytes, publicKey) {
  const manifest = parseManifest(bytes, publicKey);
  const proof = manifest.linuxPublication;
  const release = github.release(`v${manifest.version}`);
  assert(
    !release.draft && !release.prerelease && release.id === proof.releaseId,
    "Linux bundles must belong to the identified public stable release",
  );
  assert.equal(github.source(release.tag_name), proof.sourceSha, "Published Linux source changed");
  assert.deepEqual(
    github.metadata(release, manifestName(manifest.version)),
    bytes,
    "Canonical bytes differ from the immutable Linux publication",
  );
  // Core consumes the publisher's verified immutable asset IDs, not a claimed signature field.
  // GitHub replacement creates a new ID. Check its digest too when the API supplies one.
  for (const entry of proof.assets) {
    const current = asset(release, entry.name);
    assert(
      current &&
        current.id === entry.id &&
        current.size === entry.size &&
        current.state === "uploaded" &&
        current.browser_download_url === assetUrl(release.tag_name, entry.name) &&
        (current.digest == null || current.digest === `sha256:${entry.sha256}`),
      `Published Linux asset changed: ${entry.name}`,
    );
  }
  return manifest;
}

function channelBody(version) {
  const names = bundleNames(version);
  return (
    `Latest published Linux companion: v${version}\n\n` +
    `- [AppImage](${assetUrl(`v${version}`, names.appimage)})\n` +
    `- [Debian package](${assetUrl(`v${version}`, names.deb)})\n`
  );
}

function updateChannelBody(github, release, source, version) {
  const body = channelBody(version);
  if (release.body === body) {
    return;
  }
  const path = github.temp("channel-notes.md");
  writeFileSync(path, body, { flag: "wx" });
  github.unchanged(release, source);
  github.authorize();
  command("gh", [
    "release",
    "edit",
    CHANNEL,
    "--repo",
    REPOSITORY,
    "--prerelease",
    "--latest=false",
    "--notes-file",
    path,
  ]);
  assert.equal(github.release(CHANNEL).body, body, "Linux download-page readback failed");
}

function canonical(github, publicKey) {
  const release = github.release(CHANNEL);
  assert(!release.draft && release.prerelease, "Linux channel must be public and prerelease");
  const bytes = github.metadata(release, "latest.json");
  assert(
    bytes,
    "Linux channel manifest is missing; reconcile the interrupted publication from retained promotion evidence",
  );
  const manifest = publishedManifest(github, bytes, publicKey);
  assert.equal(
    github.source(CHANNEL),
    manifest.linuxPublication.channelSha,
    "Linux channel tag moved",
  );
  return { release, bytes, manifest };
}

function mirror(github, publicKey, target) {
  const latest = github.latest();
  assert(latest, "No public core latest release exists");
  const latestVersion = releaseVersion(latest.tag_name);
  assert(!latest.draft && !latest.prerelease, "Core latest is not a public regular release");
  const source = github.source(latest.tag_name);
  if (target && (target.tag !== latest.tag_name || target.source !== source)) {
    // A resume of an older release must never promote or modify it.
    const expected = github.release(target.tag);
    assert.equal(github.source(target.tag), target.source, "Selected core tag moved");
    assert(!expected.draft && !expected.prerelease, "Selected core release is not public");
    return { state: "skipped-not-latest", tag: target.tag };
  }
  const verifyLatest = () => {
    assert.deepEqual(
      identity(github.latest()),
      identity(latest),
      "Core latest changed before mirror",
    );
    assert.equal(
      github.source(latest.tag_name),
      source,
      "Core latest source changed before mirror",
    );
  };
  const selected = canonical(github, publicKey);
  assert(
    compareReleaseVersions(selected.manifest.version, latestVersion) <= 0,
    "Canonical Linux version is newer than core latest",
  );
  const previousBytes = github.metadata(latest, "latest.json");
  if (previousBytes && !previousBytes.equals(selected.bytes)) {
    const previous = JSON.parse(previousBytes);
    const legacy = !Object.hasOwn(previous, "linuxPublication");
    const owned = legacy
      ? parseLegacyManifest(previousBytes)
      : publishedManifest(github, previousBytes, publicKey);
    const comparison = compareReleaseVersions(selected.manifest.version, owned.version);
    assert(comparison >= 0, "Legacy endpoint already carries a newer Linux manifest");
    if (legacy) {
      const origin = github.release(`v${owned.version}`);
      assert(!origin.draft && !origin.prerelease, "Legacy manifest origin is not public stable");
      assert.deepEqual(
        github.metadata(origin, "latest.json"),
        previousBytes,
        "Legacy manifest differs from its public versioned origin",
      );
      const bundle = asset(origin, bundleNames(owned.version).appimage);
      assert(
        bundle &&
          Number.isSafeInteger(bundle.id) &&
          bundle.id > 0 &&
          bundle.size > 0 &&
          bundle.state === "uploaded" &&
          bundle.browser_download_url === owned.platforms["linux-x86_64"].url,
        "Legacy manifest has no matching public bundle",
      );
      if (comparison === 0) {
        const originalFields = { ...selected.manifest };
        delete originalFields.linuxPublication;
        assert.deepEqual(
          owned,
          originalFields,
          "Same-version legacy bootstrap changed original manifest fields",
        );
      }
    } else {
      assert.equal(
        owned.linuxPublication.channelSha,
        selected.manifest.linuxPublication.channelSha,
        "Legacy endpoint belongs to a different Linux channel identity",
      );
      assert(comparison > 0, "Same-version canonical manifest conflict at legacy endpoint");
    }
  }
  const beforeWrite = () => {
    assert.deepEqual(
      canonical(github, publicKey).bytes,
      selected.bytes,
      "Canonical Linux manifest changed before mirror",
    );
    verifyLatest();
  };
  beforeWrite();
  const path = github.temp("latest.json");
  writeFileSync(path, selected.bytes, { flag: "wx" });
  github.upload(latest, source, "latest.json", path, true, beforeWrite);
  assert.deepEqual(identity(github.latest()), identity(latest), "Core latest changed after mirror");
  assert.deepEqual(
    canonical(github, publicKey).bytes,
    selected.bytes,
    "Canonical Linux manifest changed after mirror",
  );
  updateChannelBody(
    github,
    selected.release,
    selected.manifest.linuxPublication.channelSha,
    selected.manifest.version,
  );
  const publicPath = github.download(
    `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`,
    METADATA_LIMIT,
  );
  assert.deepEqual(readFileSync(publicPath), selected.bytes, "Legacy endpoint readback failed");
  assert.deepEqual(
    identity(github.latest()),
    identity(latest),
    "Core latest changed during readback",
  );
  assert.equal(
    github.source(latest.tag_name),
    source,
    "Core latest source changed during readback",
  );
  return {
    state: "mirrored",
    tag: latest.tag_name,
    releaseId: latest.id,
    sourceSha: source,
    version: selected.manifest.version,
    manifestSha256: digest(selected.bytes),
  };
}

function finalizeCore(github, options) {
  const version = options.tag.slice(1);
  const parsed = parseReleaseVersion(version);
  assert(
    parsed &&
      parsed.version === version &&
      ["stable", "alpha", "beta"].includes(classifyReleaseTrain(parsed)),
    "Unsupported core GitHub release train",
  );
  assert(["true", "false"].includes(options.latest), "Expected explicit core latest intent");
  const prerelease = parsed.channel !== "stable";
  assert(!prerelease || options.latest === "false", "Prereleases cannot become core latest");
  github.authorize();
  // gh release view also discovers drafts by their pending tag; REST's tag route does not.
  const discovered = JSON.parse(
    command("gh", [
      "release",
      "view",
      options.tag,
      "--repo",
      REPOSITORY,
      "--json",
      "databaseId,tagName,isDraft,isPrerelease",
    ]),
  );
  const release = {
    id: discovered.databaseId,
    tag_name: discovered.tagName,
    draft: discovered.isDraft,
    prerelease: discovered.isPrerelease,
  };
  assert(
    Number.isSafeInteger(release.id) &&
      release.id > 0 &&
      release.tag_name === options.tag &&
      typeof release.draft === "boolean" &&
      typeof release.prerelease === "boolean",
    "Selected core release identity is invalid",
  );
  assert.equal(release.prerelease, prerelease, "Selected core prerelease classification changed");
  assert.equal(github.source(options.tag), options["source-sha"], "Selected core tag moved");
  const latest = github.latest();
  const latestSource = latest ? github.source(latest.tag_name) : null;
  let makeLatest = options.latest === "true";
  if (latest) {
    assert(!latest.draft && !latest.prerelease, "Core latest is not a public regular release");
    const latestVersion = releaseVersion(latest.tag_name);
    if (makeLatest && compareReleaseVersions(version, latestVersion) < 0) {
      makeLatest = false;
    }
    assert(
      makeLatest || latest.id !== release.id,
      "Non-latest finalization must not demote the current latest release",
    );
  }
  const verifyLatest = () => {
    const fresh = github.latest();
    assert.deepEqual(
      fresh ? identity(fresh) : null,
      latest ? identity(latest) : null,
      "Core latest changed before finalization",
    );
    if (latest) {
      assert.equal(github.source(latest.tag_name), latestSource, "Core latest tag moved");
    }
  };
  assert.deepEqual(
    identity(github.api(`releases/${release.id}`)),
    identity(release),
    "Release identity changed before write",
  );
  assert.equal(github.source(options.tag), options["source-sha"], "Selected core tag moved");
  verifyLatest();
  github.authorize();
  // Address the admitted release ID, never a re-resolved replacement with the same tag.
  command("gh", [
    "api",
    "--method",
    "PATCH",
    `repos/${REPOSITORY}/releases/${release.id}`,
    "--field",
    "draft=false",
    "--raw-field",
    `make_latest=${makeLatest}`,
  ]);
  const published = github.release(options.tag);
  assert.deepEqual(
    identity(published),
    [release.id, options.tag, false, prerelease],
    "Finalized core release identity mismatch",
  );
  assert.equal(github.source(options.tag), options["source-sha"], "Finalized core tag moved");
  const actualLatest = github.latest();
  const expectedLatest = makeLatest ? published : latest;
  assert.deepEqual(
    actualLatest ? identity(actualLatest) : null,
    expectedLatest ? identity(expectedLatest) : null,
    "Core latest readback mismatch",
  );
  if (actualLatest) {
    assert.equal(
      github.source(actualLatest.tag_name),
      makeLatest ? options["source-sha"] : latestSource,
      "Core latest source readback mismatch",
    );
  }
  return {
    state: "finalized",
    tag: options.tag,
    releaseId: release.id,
    sourceSha: options["source-sha"],
    madeLatest: makeLatest,
    latestReleaseId: actualLatest?.id ?? null,
    latestTag: actualLatest?.tag_name ?? null,
  };
}

function publishDesktopChannel(github, options, directory) {
  const tag = "desktop-test";
  const name = "latest-desktop-test.json";
  const version = releaseVersion(options.tag);
  let channel = github.release(tag, true);
  const creating = channel === null;
  if (!channel) {
    const existingTag = github.source(tag, true);
    assert(
      existingTag === null || existingTag === options["source-sha"],
      "Existing desktop channel tag has a different source; reconcile before creation",
    );
    github.authorize();
    command("gh", [
      "release",
      "create",
      tag,
      "--repo",
      REPOSITORY,
      "--target",
      options["source-sha"],
      "--prerelease",
      "--latest=false",
      "--title",
      "OpenClaw desktop test update channel",
      "--notes",
      "Opt-in updater manifest for unsigned macOS and Windows Tauri test builds.",
    ]);
    channel = github.release(tag);
  }
  assert(!channel.draft && channel.prerelease, "Desktop channel must be public and prerelease");
  // Existing channels keep their historical tag; an update never retags it.
  const source = github.source(tag);
  if (creating) {
    assert.equal(source, options["source-sha"], "Created desktop channel source mismatch");
  }
  const previous = github.metadata(channel, name);
  if (previous) {
    const current = regularVersion(JSON.parse(previous).version);
    if (compareReleaseVersions(version, current) < 0) {
      return { state: "kept-newer-channel", version: current };
    }
  }
  github.upload(channel, source, name, join(directory, name), true, () =>
    github.unchanged(channel, source),
  );
  return { state: "published", version };
}

function publicInputs(github, release, publicKey, desktop) {
  const version = releaseVersion(release.tag_name);
  const names = bundleNames(version);
  const immutable = github.metadata(release, manifestName(version));
  const bytes = immutable ?? github.metadata(release, "latest.json");
  assert(bytes, "Complete public Linux assets require their published signature manifest");
  const manifest = Object.hasOwn(JSON.parse(bytes), "linuxPublication")
    ? publishedManifest(github, bytes, publicKey)
    : parseLegacyManifest(bytes);
  assert.equal(manifest.version, version, "Public Linux inputs belong to a different version");
  const checksumAsset = asset(release, names.checksums);
  assert(checksumAsset, "Public Linux checksum asset is missing");
  const checksumPath = github.publicAsset(release, checksumAsset);
  const rows = readFileSync(checksumPath, "utf8").trimEnd().split("\n");
  const hasDesktop = rows.length === 5;
  const expected = [names.appimage, names.deb, ...(hasDesktop ? names.desktop : [])].toSorted();
  assert.deepEqual(
    rows
      .map((row) => {
        const match = /^([0-9a-f]{64}) {2}\.\/([^/]+)$/u.exec(row);
        assert(match, "Invalid public Linux checksum entry");
        return match[2];
      })
      .toSorted(),
    expected,
    "Public Linux checksum inventory mismatch",
  );
  assert(!desktop || hasDesktop, "Opt-in desktop publication requires its complete public bundles");
  const directory = mkdtempSync(join(github.directory, "public-inputs-"));
  copyFileSync(checksumPath, join(directory, names.checksums));
  for (const name of expected) {
    const entry = asset(release, name);
    assert(entry, `Public Linux input is missing: ${name}`);
    copyFileSync(github.publicAsset(release, entry, BUNDLE_LIMIT), join(directory, name));
  }
  if (desktop) {
    const metadata = github.metadata(release, "latest-desktop-test.json");
    assert(metadata, "Public desktop test manifest is missing");
    writeFileSync(join(directory, "latest-desktop-test.json"), metadata, { flag: "wx" });
  }
  return { directory, signature: manifest.platforms["linux-x86_64"].signature, hasDesktop };
}

function publish(github, options, publicKey) {
  const version = releaseVersion(options.tag);
  const names = bundleNames(version);
  const release = github.release(options.tag);
  assert(
    !release.draft && !release.prerelease,
    "Publish Linux bundles only to a public stable release",
  );
  assert.equal(github.source(options.tag), options["source-sha"], "Linux release source mismatch");
  const desktop = options["desktop-test"] === "true";
  // Idempotent native requests can finish channel publication from the exact
  // public bundles. They do not require or rebuild discarded runner artifacts.
  const retainedInputs = options.assets ? null : publicInputs(github, release, publicKey, desktop);
  const directory = retainedInputs?.directory ?? resolve(options.assets);
  const expected = [
    names.appimage,
    names.deb,
    names.checksums,
    ...(retainedInputs?.hasDesktop || desktop ? names.desktop : []),
  ].toSorted();
  assert.deepEqual(
    readdirSync(directory).toSorted(),
    [...expected, ...(desktop ? ["latest-desktop-test.json"] : [])].toSorted((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    "Release directory does not match the admitted bundle inventory",
  );
  const inputs = expected.map((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    assert(
      stat.isFile() && stat.size > 0 && stat.size <= BUNDLE_LIMIT,
      `Invalid release input: ${name}`,
    );
    return { name, path, size: stat.size, sha256: fileDigest(path) };
  });
  const checksums = inputs
    .filter((entry) => entry.name !== names.checksums)
    .map((entry) => `${entry.sha256}  ./${entry.name}`)
    .toSorted()
    .join("\n");
  assert.equal(
    readFileSync(join(directory, names.checksums), "utf8")
      .trimEnd()
      .split("\n")
      .toSorted()
      .join("\n"),
    checksums,
    "Bundle checksum inventory mismatch",
  );
  const signature = retainedInputs?.signature ?? readFileSync(options.signature, "utf8").trim();
  assert(signature.length > 0 && signature.length <= 16_384, "Invalid AppImage signature input");
  const signaturePath = github.temp("appimage.minisig");
  const publicKeyPath = github.temp("updater.pub");
  writeFileSync(signaturePath, Buffer.from(signature, "base64"), { flag: "wx" });
  writeFileSync(publicKeyPath, Buffer.from(publicKey, "base64"), { flag: "wx" });
  command("minisign", [
    "-Vm",
    join(directory, names.appimage),
    "-x",
    signaturePath,
    "-p",
    publicKeyPath,
  ]);

  // Detect every immutable conflict before uploading any missing file.
  for (const entry of inputs) {
    const previous = asset(release, entry.name);
    if (previous) {
      assert.equal(
        fileDigest(github.publicAsset(release, previous, BUNDLE_LIMIT)),
        entry.sha256,
        `Immutable asset conflict: ${entry.name}`,
      );
    }
  }
  for (const entry of inputs) {
    github.upload(
      github.unchanged(release, options["source-sha"]),
      options["source-sha"],
      entry.name,
      entry.path,
    );
  }
  const published = github.unchanged(release, options["source-sha"]);
  const assets = inputs.map((entry) => {
    const current = asset(published, entry.name);
    assert(current, `Missing public bundle: ${entry.name}`);
    assert.equal(
      fileDigest(github.publicAsset(published, current, BUNDLE_LIMIT)),
      entry.sha256,
      `Public bundle differs from signed input: ${entry.name}`,
    );
    return { id: current.id, name: entry.name, size: entry.size, sha256: entry.sha256 };
  });
  let channel = github.release(CHANNEL, true);
  const creatingChannel = channel === null;
  if (!channel) {
    const retainedTag = github.source(CHANNEL, true);
    assert(
      retainedTag === null || retainedTag === options["source-sha"],
      "Existing Linux channel tag has a different source; reconcile before creating its release",
    );
    github.authorize();
    command("gh", [
      "release",
      "create",
      CHANNEL,
      "--repo",
      REPOSITORY,
      "--target",
      options["source-sha"],
      "--prerelease",
      "--latest=false",
      "--title",
      "OpenClaw Linux update channel",
      "--notes",
      INITIAL_BODY,
    ]);
    channel = github.release(CHANNEL);
  }
  assert(!channel.draft && channel.prerelease, "Linux channel must be public and prerelease");
  const channelSha = github.source(CHANNEL);
  const currentBytes = github.metadata(channel, "latest.json");
  let current;
  if (currentBytes) {
    current = publishedManifest(github, currentBytes, publicKey);
    assert.equal(current.linuxPublication.channelSha, channelSha, "Linux channel tag moved");
  } else {
    assert(
      creatingChannel && channel.body === INITIAL_BODY && channelSha === options["source-sha"],
      "Missing channel metadata is not a new channel; reconcile before publishing",
    );
  }
  const existing = github.metadata(published, manifestName(version));
  let bytes = existing;
  if (existing) {
    const retained = publishedManifest(github, existing, publicKey);
    assert.equal(retained.version, version, "Versioned manifest identity mismatch");
    assert.equal(
      retained.linuxPublication.channelSha,
      channelSha,
      "Channel identity changed on replay",
    );
    assert.deepEqual(retained.linuxPublication.assets, assets, "Bundle identity changed on replay");
    // Re-signing identical bytes can change the trusted timestamp comment. Verify
    // and retain the original signature instead of regenerating immutable metadata.
    writeFileSync(
      signaturePath,
      Buffer.from(retained.platforms["linux-x86_64"].signature, "base64"),
    );
    command("minisign", [
      "-Vm",
      join(directory, names.appimage),
      "-x",
      signaturePath,
      "-p",
      publicKeyPath,
    ]);
  } else {
    assert(
      typeof published.published_at === "string" &&
        Number.isFinite(Date.parse(published.published_at)),
      "Public release publication date is required",
    );
    let originalFields;
    const legacyBytes = github.metadata(published, "latest.json");
    if (legacyBytes) {
      if (Object.hasOwn(JSON.parse(legacyBytes), "linuxPublication")) {
        publishedManifest(github, legacyBytes, publicKey);
      } else {
        const legacy = parseLegacyManifest(legacyBytes);
        if (legacy.version === version) {
          originalFields = legacy;
          writeFileSync(
            signaturePath,
            Buffer.from(legacy.platforms["linux-x86_64"].signature, "base64"),
          );
          command("minisign", [
            "-Vm",
            join(directory, names.appimage),
            "-x",
            signaturePath,
            "-p",
            publicKeyPath,
          ]);
        }
      }
    }
    bytes = Buffer.from(
      `${JSON.stringify(
        {
          ...(originalFields ?? {
            version,
            notes: Array.from(published.body ?? "")
              .slice(0, 2000)
              .join(""),
            pub_date: published.published_at,
            platforms: {
              "linux-x86_64": {
                signature,
                url: assetUrl(options.tag, names.appimage),
              },
            },
          }),
          linuxPublication: {
            schemaVersion: 1,
            sourceSha: options["source-sha"],
            toolingSha: options["tooling-sha"],
            channelSha,
            releaseId: published.id,
            publicKeySha256: digest(Buffer.from(publicKey, "base64")),
            assets,
          },
        },
        null,
        2,
      )}\n`,
    );
    const path = github.temp("versioned-linux.json");
    writeFileSync(path, bytes, { flag: "wx" });
    github.upload(published, options["source-sha"], manifestName(version), path);
  }
  const comparison = current ? compareReleaseVersions(version, current.version) : 1;
  if (comparison === 0) {
    assert.deepEqual(bytes, currentBytes, "Same-version canonical manifest conflict");
  }
  if (comparison >= 0) {
    const path = github.temp("canonical-linux.json");
    writeFileSync(path, bytes, { flag: "wx" });
    report(
      JSON.stringify({
        state: "canonical-publication-intent",
        version,
        manifestSha256: digest(bytes),
        previousVersion: current?.version ?? null,
        previousManifestSha256: currentBytes ? digest(currentBytes) : null,
      }),
    );
    github.upload(channel, channelSha, "latest.json", path, true);
    updateChannelBody(github, channel, channelSha, version);
    assert.deepEqual(canonical(github, publicKey).bytes, bytes, "Linux channel readback failed");
  }
  if (desktop) {
    const desktopName = "latest-desktop-test.json";
    const desktopPath = join(directory, desktopName);
    const candidate = JSON.parse(readFileSync(desktopPath, "utf8"));
    assert.equal(candidate.version, version, "Desktop test manifest version mismatch");
    assert.deepEqual(
      Object.keys(candidate.platforms).toSorted(),
      ["darwin-aarch64", "windows-x86_64"],
      "Unexpected desktop test platforms",
    );
    const previous = github.metadata(github.unchanged(release, options["source-sha"]), desktopName);
    if (previous) {
      const retained = JSON.parse(previous);
      assert.equal(retained.version, candidate.version, "Desktop test manifest version changed");
      assert.deepEqual(
        Object.keys(retained.platforms).toSorted(),
        Object.keys(candidate.platforms).toSorted(),
        "Desktop test platforms changed",
      );
      for (const [platform, name] of [
        ["darwin-aarch64", names.desktop[1]],
        ["windows-x86_64", names.desktop[2]],
      ]) {
        assert.equal(
          retained.platforms[platform].url,
          candidate.platforms[platform].url,
          "Desktop test bundle URL changed",
        );
        const previousSignature = retained.platforms[platform].signature;
        assert(
          typeof previousSignature === "string" &&
            previousSignature.length > 0 &&
            previousSignature.length <= 16_384,
          "Invalid retained desktop signature",
        );
        writeFileSync(signaturePath, Buffer.from(previousSignature, "base64"));
        command("minisign", [
          "-Vm",
          join(directory, name),
          "-x",
          signaturePath,
          "-p",
          publicKeyPath,
        ]);
      }
      // Keep the previously published date/notes on an identical bundle replay.
      writeFileSync(desktopPath, previous);
    }
    github.upload(
      github.unchanged(release, options["source-sha"]),
      options["source-sha"],
      desktopName,
      desktopPath,
    );
  }
  const legacy = mirror(github, publicKey);
  const desktopChannel = desktop ? publishDesktopChannel(github, options, directory) : undefined;
  return {
    state: comparison < 0 ? "kept-newer-channel" : "published",
    version,
    manifestSha256: digest(bytes),
    legacy,
    ...(desktop ? { desktop: desktopChannel } : {}),
  };
}

function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "tag",
        "source-sha",
        "tooling-sha",
        "workflow-ref",
        "workflow-full-ref",
        "release-publish-run-id",
        "release-publish-run-attempt",
        "release-publish-ref",
        "release-publish-full-ref",
        "request-run-id",
        "request-run-attempt",
        "assets",
        "signature",
        "public-key-config",
        "desktop-test",
        "latest",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  const [mode] = positionals;
  assert(
    positionals.length === 1 && ["publish", "mirror", "finalize-core"].includes(mode),
    "Usage: linux-app-channel.mjs publish|mirror|finalize-core --tag TAG --source-sha SHA [mode options]",
  );
  assert(SHA.test(values["source-sha"]), "Expected the approved source SHA");
  assert(
    SHA.test(values["tooling-sha"]) && values["workflow-ref"] && values["workflow-full-ref"],
    "Missing publication tooling identity",
  );
  const identityKeys =
    mode === "publish"
      ? ["request-run-id", "request-run-attempt"]
      : ["release-publish-run-id", "release-publish-run-attempt"];
  for (const key of identityKeys) {
    assert(
      /^[1-9][0-9]*$/u.test(values[key]) && Number.isSafeInteger(Number(values[key])),
      `Missing or invalid ${key}`,
    );
  }
  if (mode === "publish") {
    assert(
      values["workflow-ref"] === "main" && values["workflow-full-ref"] === "refs/heads/main",
      "Native publication requires the admitted main request route",
    );
  } else {
    assert(
      values["release-publish-ref"] && values["release-publish-full-ref"],
      "Missing core publisher identity",
    );
  }
  assert(typeof values.tag === "string" && values.tag.startsWith("v"), "Expected a release tag");
  if (mode !== "finalize-core") {
    releaseVersion(values.tag);
  }
  if (mode === "publish") {
    assert(
      SHA.test(values["tooling-sha"]) &&
        Boolean(values.assets) === Boolean(values.signature) &&
        ["true", "false"].includes(values["desktop-test"]),
      "Missing Linux publication inputs",
    );
  }
  let publicKey;
  if (mode !== "finalize-core") {
    const config = JSON.parse(readFileSync(values["public-key-config"], "utf8"));
    publicKey = config.plugins?.updater?.pubkey;
    assert(
      typeof publicKey === "string" &&
        publicKey.length > 0 &&
        publicKey.length <= 4096 &&
        /^[A-Za-z0-9+/]+={0,2}$/u.test(publicKey),
      "Expected the trusted updater public key",
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "openclaw-linux-channel-"));
  try {
    const github = new GitHub(directory, mode, values);
    if (mode !== "finalize-core") {
      github.authorize();
    }
    const result =
      mode === "finalize-core"
        ? finalizeCore(github, values)
        : mode === "publish"
          ? publish(github, values, publicKey)
          : mirror(github, publicKey, { tag: values.tag, source: values["source-sha"] });
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runLinuxAppChannel(args, options = {}) {
  // The workflow uses the default process boundaries. Tests inject synchronous
  // command/report adapters so fault-heavy cases do not launch hundreds of
  // short-lived Node processes.
  const previousCommandOverride = commandOverride;
  const previousReportOverride = reportOverride;
  commandOverride = options.runCommand;
  reportOverride = options.report;
  try {
    return main(args);
  } finally {
    commandOverride = previousCommandOverride;
    reportOverride = previousReportOverride;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(`${JSON.stringify(runLinuxAppChannel(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    console.error(`Release publication incomplete; reconcile before retry: ${error.message}`);
    process.exitCode = 1;
  }
}
