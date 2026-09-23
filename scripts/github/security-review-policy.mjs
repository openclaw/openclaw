import { readFileSync } from "node:fs";
import { Minimatch } from "minimatch";
import { parseDocument } from "yaml";

const policyPath = new URL("../../.github/security-review-policy.yml", import.meta.url);
/** @type {{
 *   rolloutPullRequest: number | undefined,
 *   isDependencyManifest: (filename: string) => boolean,
 *   isPackageLockfile: (filename: string) => boolean,
 *   isDependencyFile: (filename: string) => boolean,
 *   collectSecuritySensitiveChanges: (
 *     files: Array<string | { filename?: string, previous_filename?: string }>
 *   ) => Array<{ path: string, reason: string }>,
 * } | undefined} */
let cachedPolicy;

function invalid(message) {
  throw new Error(`Invalid security-review-policy.yml: ${message}`);
}

function mapping(value, location, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${location} must be a mapping`);
  }
  if (fields) {
    for (const key of Object.keys(value)) {
      if (!fields.includes(key)) {
        invalid(`${location}.${key} is not a supported field`);
      }
    }
  }
  return value;
}

function text(value, location) {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${location} must be nonempty text`);
  }
  return value;
}

function paths(value, location, nocase = false) {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(`${location} must be a nonempty list of glob patterns`);
  }
  const patterns = value.map((entry, index) => {
    const pattern = text(entry, `${location}[${index}]`);
    if (/^[!#/]|\\|(?:^|\/)\.{1,2}(?:\/|$)/u.test(pattern)) {
      invalid(`${location}[${index}] must be a repository-relative glob without negation`);
    }
    return new Minimatch(pattern, {
      dot: true,
      nocase,
      nonegate: true,
      nocomment: true,
      noext: true,
      platform: "linux",
    });
  });
  return (filename) => patterns.some((pattern) => pattern.match(filename));
}

// The trusted checkout is immutable per run. Callers must fail the current
// revision if this policy cannot be loaded.
export function loadSecurityReviewPolicy() {
  if (cachedPolicy) {
    return cachedPolicy;
  }
  const document = parseDocument(readFileSync(policyPath, "utf8"));
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) {
    invalid(problem.message);
  }
  const policy = mapping(document.toJS({ maxAliasCount: 0 }), "policy", [
    "exclude",
    "categories",
    "dependencies",
    "rollout",
  ]);
  let rolloutPullRequest;
  if (policy.rollout !== undefined) {
    const rollout = mapping(policy.rollout, "rollout", ["pull-request"]);
    if (!Number.isSafeInteger(rollout["pull-request"]) || rollout["pull-request"] <= 0) {
      invalid("rollout.pull-request must be a positive safe integer");
    }
    rolloutPullRequest = rollout["pull-request"];
  }
  const excluded = Object.entries(mapping(policy.exclude, "exclude")).map(([name, value]) => {
    const rule = mapping(value, `exclude.${name}`, ["paths", "case-insensitive"]);
    if (rule["case-insensitive"] !== undefined && typeof rule["case-insensitive"] !== "boolean") {
      invalid(`exclude.${name}.case-insensitive must be a boolean`);
    }
    return paths(rule.paths, `exclude.${name}.paths`, rule["case-insensitive"] === true);
  });
  const categories = Object.entries(mapping(policy.categories, "categories")).map(
    ([name, value]) => {
      const rule = mapping(value, `categories.${name}`, ["description", "review", "paths"]);
      return {
        reason: `${text(rule.description, `categories.${name}.description`)} ${text(rule.review, `categories.${name}.review`)}`,
        matches: paths(rule.paths, `categories.${name}.paths`),
      };
    },
  );
  if (categories.length === 0) {
    invalid("categories must not be empty");
  }
  const dependencies = mapping(policy.dependencies, "dependencies", [
    "manifests",
    "lockfiles",
    "other",
  ]);
  const isDependencyManifest = paths(dependencies.manifests, "dependencies.manifests");
  const isPackageLockfile = paths(dependencies.lockfiles, "dependencies.lockfiles");
  const isOtherDependencyFile = paths(dependencies.other, "dependencies.other");
  cachedPolicy = {
    rolloutPullRequest,
    isDependencyManifest,
    isPackageLockfile,
    isDependencyFile: (filename) => isPackageLockfile(filename) || isOtherDependencyFile(filename),
    collectSecuritySensitiveChanges(files) {
      const changes = new Map();
      for (const file of files) {
        const filenames =
          typeof file === "string" ? [file] : [file?.filename, file?.previous_filename];
        for (const filename of filenames) {
          if (typeof filename !== "string" || excluded.some((matches) => matches(filename))) {
            continue;
          }
          const rule = categories.find((category) => category.matches(filename));
          if (rule) {
            changes.set(filename, { path: filename, reason: rule.reason });
          }
        }
      }
      return [...changes.values()].toSorted((left, right) => left.path.localeCompare(right.path));
    },
  };
  return cachedPolicy;
}
