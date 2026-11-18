import { parseReleaseVersion } from "../lib/release-version.mjs";
import { GitHubDiffDataError } from "./guard-shared.mjs";
import { loadSecurityReviewPolicy } from "./security-review-policy.mjs";

const dependencyManifestFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "dependenciesMeta",
  "overrides",
  "resolutions",
  "packageManager",
  "workspaces",
  "pnpm",
  "name",
  "version",
  "engines",
  "os",
  "cpu",
  "libc",
];

export function dependencyFieldChanges(baseManifest, headManifest) {
  const changes = [];
  for (const field of dependencyManifestFields) {
    if (stableJson(baseManifest?.[field] ?? null) !== stableJson(headManifest?.[field] ?? null)) {
      changes.push(field);
    }
  }
  return changes;
}

function stableJson(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = {};
  for (const key of Object.keys(value).toSorted((left, right) => left.localeCompare(right))) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

function isReleaseVersionOnly(path, base, head, fields) {
  const { isReleaseManifest } = loadSecurityReviewPolicy();
  if (!base || !head || !isReleaseManifest(path)) {
    return false;
  }
  return fields.every((field) => {
    if (field === "version") {
      return Boolean(
        typeof base.version === "string" &&
        typeof head.version === "string" &&
        parseReleaseVersion(base.version) &&
        parseReleaseVersion(head.version),
      );
    }
    if (
      !path.startsWith("extensions/") ||
      !["devDependencies", "peerDependencies"].includes(field)
    ) {
      return false;
    }
    const before = base[field];
    const after = head[field];
    // Release sync changes existing >=openclaw floors, not dependencies or sources.
    const versionFloor = (value) =>
      typeof value === "string" && value.startsWith(">=") && parseReleaseVersion(value.slice(2));
    return Boolean(
      versionFloor(before?.openclaw) &&
      versionFloor(after?.openclaw) &&
      stableJson({ ...before, openclaw: null }) === stableJson({ ...after, openclaw: null }),
    );
  });
}

function decodeContentFile(payload) {
  if (!payload || payload.type !== "file" || typeof payload.content !== "string") {
    return null;
  }
  return Buffer.from(payload.content, payload.encoding ?? "base64").toString("utf8");
}

async function readJsonFileAtRef(api, options) {
  const payload = await readContentFileMetadataAtRef(api, options);
  const text = decodeContentFile(payload);
  return text ? JSON.parse(text) : null;
}

async function readContentFileMetadataAtRef(api, { owner, repo, path, ref }) {
  if (!ref) {
    return null;
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return api
    .request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`)
    .catch((error) => {
      if (error?.status === 404) {
        return null;
      }
      throw error;
    });
}

export async function readBase64FileAtRef(api, { owner, repo, path, ref }) {
  const file = await readContentFileMetadataAtRef(api, { owner, repo, path, ref });
  if (!file) {
    return null;
  }
  if (file.encoding === "base64" && typeof file.content === "string" && file.content.length > 0) {
    return file.content.replace(/\s+/gu, "");
  }
  if (typeof file.sha === "string" && file.sha.length > 0) {
    const blob = await api.request(`/repos/${owner}/${repo}/git/blobs/${file.sha}`);
    if (blob.encoding === "base64" && typeof blob.content === "string" && blob.content.length > 0) {
      return blob.content.replace(/\s+/gu, "");
    }
  }
  throw new Error(`Unable to read base64 file contents for ${path}`);
}

export async function readDependencyMergeBase(api, { owner, repo, pullRequest }) {
  // Match the PR diff, not unrelated updates on the target branch. Page two
  // omits file patches; only the comparison metadata is needed.
  const baseSha = pullRequest.base?.sha;
  const comparison = await api.request(
    `/repos/${owner}/${repo}/compare/${baseSha}...${pullRequest.head?.sha}?per_page=1&page=2`,
  );
  if (
    comparison?.base_commit?.sha !== baseSha ||
    !/^[a-f0-9]{40}$/u.test(comparison?.merge_base_commit?.sha ?? "")
  ) {
    throw new GitHubDiffDataError("GitHub returned an invalid dependency merge base.");
  }
  return comparison.merge_base_commit.sha;
}

export async function collectDependencyManifestChanges(api, { owner, repo, pullRequest, files }) {
  const { isDependencyManifest } = loadSecurityReviewPolicy();
  const changes = [];
  let mergeBaseSha;
  for (const file of files) {
    const basePath = file.previous_filename ?? file.filename;
    const headPath = file.filename;
    if (!isDependencyManifest(basePath) && !isDependencyManifest(headPath)) {
      continue;
    }
    if (!mergeBaseSha) {
      mergeBaseSha = await readDependencyMergeBase(api, { owner, repo, pullRequest });
    }
    const baseManifest = isDependencyManifest(basePath)
      ? await readJsonFileAtRef(api, { owner, repo, path: basePath, ref: mergeBaseSha })
      : null;
    const headManifest = isDependencyManifest(headPath)
      ? await readJsonFileAtRef(api, { owner, repo, path: headPath, ref: pullRequest.head?.sha })
      : null;
    const fields = dependencyFieldChanges(baseManifest, headManifest);
    if (fields.length > 0 || basePath !== headPath) {
      changes.push({
        releaseVersionOnly:
          isReleaseVersionOnly(headPath, baseManifest, headManifest, fields) &&
          basePath === headPath,
        path: headPath,
        fields,
        ...(basePath !== headPath ? { previousPath: basePath } : {}),
      });
    }
  }
  return changes;
}
