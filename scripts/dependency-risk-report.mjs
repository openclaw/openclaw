#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import {
  collectAllResolvedPackagesFromLockfile,
  createBulkAdvisoryPayload,
} from "./pre-commit/pnpm-audit-prod.mjs";

const DEFAULT_EXCEPTIONS_PATH = "config/dependency-risk-exceptions.yaml";
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_NPM_ALIAS_PATTERN =
  /^npm:(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PINNED_GIT_PATTERN = /(?:#|\/commit\/)[0-9a-f]{40}$/iu;
const EXOTIC_SPEC_PATTERN = /^(?:git\+|github:|gitlab:|bitbucket:|https?:)/iu;

function isAllowedPinnedSpec(spec) {
  if (typeof spec !== "string") {
    return false;
  }
  if (EXACT_SEMVER_PATTERN.test(spec) || EXACT_NPM_ALIAS_PATTERN.test(spec)) {
    return true;
  }
  if (spec === "workspace:*" || spec.startsWith("file:") || spec.startsWith("link:")) {
    return true;
  }
  if (/^(?:git\+|github:|gitlab:|bitbucket:)/u.test(spec)) {
    return PINNED_GIT_PATTERN.test(spec);
  }
  return false;
}

function encodePackageName(name) {
  return name.startsWith("@") ? name.replace("/", "%2f") : name;
}

function resolveRegistryBaseUrl() {
  const configured =
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    process.env.npm_config_userconfig_registry ??
    "https://registry.npmjs.org";
  return configured.replace(/\/+$/u, "");
}

function isExoticResolvedVersion(version) {
  return EXOTIC_SPEC_PATTERN.test(version);
}

function packageVersionsFromPayload(payload) {
  return Object.entries(payload).flatMap(([packageName, versions]) =>
    versions.map((version) => ({ packageName, version })),
  );
}

async function loadWorkspaceRiskSettings(rootDir) {
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  try {
    const workspace = YAML.parse(await readFile(workspacePath, "utf8"));
    return {
      minimumReleaseAgeMinutes:
        typeof workspace?.minimumReleaseAge === "number" ? workspace.minimumReleaseAge : null,
    };
  } catch {
    return { minimumReleaseAgeMinutes: null };
  }
}

function validateException(exception, index) {
  const errors = [];
  const prefix = `exceptions[${index}]`;
  if (!exception || typeof exception !== "object") {
    return [`${prefix} must be an object.`];
  }
  if (typeof exception.reason !== "string" || exception.reason.trim() === "") {
    errors.push(`${prefix}.reason must be a non-empty string.`);
  }
  if (!exception.match || typeof exception.match !== "object") {
    errors.push(`${prefix}.match must be an object.`);
    return errors;
  }
  if (typeof exception.match.package !== "string" || exception.match.package.trim() === "") {
    errors.push(`${prefix}.match.package must be a non-empty string.`);
  }
  const hasDependency =
    exception.match.dependency && typeof exception.match.dependency === "object";
  const hasDiscriminator =
    typeof exception.match.version === "string" ||
    typeof exception.match.script === "string" ||
    typeof exception.match.source === "string" ||
    hasDependency;
  if (!hasDiscriminator) {
    errors.push(`${prefix}.match must include at least one precise discriminator besides package.`);
  }
  if (hasDependency) {
    if (
      typeof exception.match.dependency.name !== "string" ||
      exception.match.dependency.name.trim() === ""
    ) {
      errors.push(`${prefix}.match.dependency.name must be a non-empty string.`);
    }
  }
  return errors;
}

export function parseKnownRiskExceptions(text) {
  const parsed = YAML.parse(text) ?? {};
  const exceptions = Array.isArray(parsed.exceptions) ? parsed.exceptions : [];
  const errors = exceptions.flatMap((exception, index) => validateException(exception, index));
  return { exceptions, errors };
}

async function loadKnownRiskExceptions(rootDir, exceptionsPath) {
  try {
    return parseKnownRiskExceptions(await readFile(path.join(rootDir, exceptionsPath), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exceptions: [], errors: [] };
    }
    throw error;
  }
}

function matchesException(finding, exception) {
  const match = exception.match;
  if (match.package !== finding.packageName) {
    return false;
  }
  if (typeof match.version === "string" && match.version !== finding.version) {
    return false;
  }
  if (typeof match.script === "string" && match.script !== finding.script) {
    return false;
  }
  if (typeof match.source === "string" && match.source !== finding.source) {
    return false;
  }
  if (match.dependency) {
    if (finding.dependency?.name !== match.dependency.name) {
      return false;
    }
    if (
      typeof match.dependency.spec === "string" &&
      finding.dependency?.spec !== match.dependency.spec
    ) {
      return false;
    }
  }
  return true;
}

function annotateKnownFindings(findings, exceptions) {
  const usedExceptionIndexes = new Set();
  const annotated = findings.map((finding) => {
    const exceptionIndex = exceptions.findIndex((exception) =>
      matchesException(finding, exception),
    );
    if (exceptionIndex === -1) {
      return { ...finding, known: false, reason: null };
    }
    usedExceptionIndexes.add(exceptionIndex);
    return {
      ...finding,
      known: true,
      reason: exceptions[exceptionIndex].reason,
    };
  });
  const unusedExceptions = exceptions
    .map((exception, index) => ({ exception, index }))
    .filter(({ index }) => !usedExceptionIndexes.has(index));
  return { findings: annotated, unusedExceptions };
}

function collectManifestFindings({
  packageName,
  version,
  manifest,
  publishedAt,
  now,
  minimumReleaseAgeMinutes,
}) {
  const findings = [];
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [dependencyName, spec] of Object.entries(manifest[section] ?? {})) {
      if (!isAllowedPinnedSpec(spec)) {
        findings.push({
          type: "floating-transitive-spec",
          packageName,
          version,
          dependency: { name: dependencyName, spec, section },
        });
      }
      if (typeof spec === "string" && EXOTIC_SPEC_PATTERN.test(spec)) {
        findings.push({
          type: "exotic-source",
          packageName,
          version,
          source: spec,
          dependency: { name: dependencyName, spec, section },
        });
      }
    }
  }

  const scripts = manifest.scripts ?? {};
  for (const script of INSTALL_LIFECYCLE_SCRIPTS) {
    if (typeof scripts[script] === "string") {
      findings.push({ type: "lifecycle-script", packageName, version, script });
    }
  }

  if (!publishedAt) {
    findings.push({ type: "missing-publish-time", packageName, version });
  } else if (typeof minimumReleaseAgeMinutes === "number") {
    const ageMs = now.getTime() - Date.parse(publishedAt);
    if (Number.isFinite(ageMs) && ageMs < minimumReleaseAgeMinutes * 60_000) {
      findings.push({
        type: "young-package",
        packageName,
        version,
        publishedAt,
        minimumReleaseAgeMinutes,
      });
    }
  }

  return findings;
}

async function fetchNpmManifest({ packageName, version, fetchImpl, registryBaseUrl }) {
  const response = await fetchImpl(`${registryBaseUrl}/${encodePackageName(packageName)}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const packument = await response.json();
  const manifest = packument.versions?.[version];
  if (!manifest) {
    throw new Error(`version ${version} not found`);
  }
  return {
    manifest,
    publishedAt: typeof packument.time?.[version] === "string" ? packument.time[version] : null,
  };
}

export async function createDependencyRiskReport({
  packageVersions,
  exceptions = [],
  manifestLoader,
  now = new Date(),
  minimumReleaseAgeMinutes = null,
}) {
  const findings = [];
  const metadataFailures = [];
  for (const { packageName, version } of packageVersions) {
    if (isExoticResolvedVersion(version)) {
      findings.push({
        type: "exotic-source",
        packageName,
        version,
        source: version,
      });
      continue;
    }
    try {
      const { manifest, publishedAt } = await manifestLoader({ packageName, version });
      findings.push(
        ...collectManifestFindings({
          packageName,
          version,
          manifest,
          publishedAt,
          now,
          minimumReleaseAgeMinutes,
        }),
      );
    } catch (error) {
      metadataFailures.push({
        packageName,
        version,
        error: String(error?.message ?? error),
      });
    }
  }
  const annotated = annotateKnownFindings(findings, exceptions);
  const byType = annotated.findings.reduce((counts, finding) => {
    counts[finding.type] = (counts[finding.type] ?? 0) + 1;
    return counts;
  }, {});
  const knownByType = annotated.findings.reduce((counts, finding) => {
    if (finding.known) {
      counts[finding.type] = (counts[finding.type] ?? 0) + 1;
    }
    return counts;
  }, {});
  return {
    generatedAt: now.toISOString(),
    packageVersions: packageVersions.length,
    findingCount: annotated.findings.length,
    knownFindingCount: annotated.findings.filter((finding) => finding.known).length,
    byType,
    knownByType,
    metadataFailures,
    unusedExceptions: annotated.unusedExceptions,
    findings: annotated.findings.toSorted((left, right) => {
      if (left.type !== right.type) {
        return left.type.localeCompare(right.type);
      }
      if (left.packageName !== right.packageName) {
        return left.packageName.localeCompare(right.packageName);
      }
      return left.version.localeCompare(right.version);
    }),
  };
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function findingPackageKey(finding) {
  return `${finding.packageName}@${finding.version}`;
}

function incrementMapCount(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCountEntries(map) {
  return [...map.entries()].toSorted((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
}

function typeBreakdown(findings) {
  const counts = new Map();
  for (const finding of findings) {
    incrementMapCount(counts, finding.type);
  }
  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

function collectMarkdownRollups(findings) {
  const packageFindings = new Map();
  const floatingTargets = new Map();
  const lifecyclePackages = new Map();
  const youngPackages = [];
  const exoticSources = [];

  for (const finding of findings) {
    const packageKey = findingPackageKey(finding);
    const packageList = packageFindings.get(packageKey) ?? [];
    packageList.push(finding);
    packageFindings.set(packageKey, packageList);

    if (finding.type === "floating-transitive-spec" && finding.dependency?.name) {
      const target = floatingTargets.get(finding.dependency.name) ?? {
        declarations: 0,
        sourcePackages: new Set(),
        specifiers: new Map(),
      };
      target.declarations += 1;
      target.sourcePackages.add(packageKey);
      incrementMapCount(target.specifiers, finding.dependency.spec ?? "unknown");
      floatingTargets.set(finding.dependency.name, target);
    }

    if (finding.type === "lifecycle-script") {
      const scripts = lifecyclePackages.get(packageKey) ?? new Set();
      scripts.add(finding.script ?? "unknown");
      lifecyclePackages.set(packageKey, scripts);
    }

    if (finding.type === "young-package") {
      youngPackages.push(finding);
    }

    if (finding.type === "exotic-source") {
      exoticSources.push(finding);
    }
  }

  return {
    packageFindings,
    floatingTargets,
    lifecyclePackages,
    youngPackages,
    exoticSources,
  };
}

function renderCompleteEvidence(lines) {
  lines.push("## Complete Evidence", "");
  lines.push(
    "The complete finding list is available in the JSON report, including every package, version, dependency, specifier, and known-risk annotation. The sections below summarize the same findings by package, dependency target, and finding class for human review.",
  );
  lines.push("");
}

function renderKnownExceptionSummary(lines, report) {
  lines.push("## Known Exception Summary", "");
  lines.push(`- Known findings: ${report.knownFindingCount}`);
  lines.push(`- Unused known-risk entries: ${report.unusedExceptions.length}`);
  lines.push("");
}

function renderPackageFindingSummary(lines, packageFindings) {
  lines.push("## Published Package Manifests With Risk Findings", "");
  for (const [packageKey, findings] of [...packageFindings.entries()].toSorted((left, right) => {
    if (right[1].length !== left[1].length) {
      return right[1].length - left[1].length;
    }
    return left[0].localeCompare(right[0]);
  })) {
    lines.push(
      `- ${markdownCode(packageKey)}: ${pluralize(findings.length, "manifest finding")} ` +
        `(${typeBreakdown(findings)})`,
    );
  }
  lines.push("");
}

function renderFloatingDependencyTargets(lines, floatingTargets) {
  if (floatingTargets.size === 0) {
    return;
  }

  lines.push("## Floating Dependency Targets", "");
  for (const [dependencyName, detail] of [...floatingTargets.entries()].toSorted((left, right) => {
    if (right[1].declarations !== left[1].declarations) {
      return right[1].declarations - left[1].declarations;
    }
    return left[0].localeCompare(right[0]);
  })) {
    const specifiers = sortedCountEntries(detail.specifiers)
      .map(([specifier, count]) => `${specifier}: ${count}`)
      .join(", ");
    lines.push(
      `- ${markdownCode(dependencyName)}: ${detail.declarations} declarations from ` +
        `${detail.sourcePackages.size} resolved packages; specifiers: ${specifiers}`,
    );
  }
  lines.push("");
}

function renderLifecycleScriptPackages(lines, lifecyclePackages) {
  if (lifecyclePackages.size === 0) {
    return;
  }

  lines.push("## Lifecycle Script Packages", "");
  for (const [packageKey, scripts] of [...lifecyclePackages.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`- ${markdownCode(packageKey)}: ${[...scripts].toSorted().join(", ")}`);
  }
  lines.push("");
}

function renderYoungPackages(lines, youngPackages) {
  if (youngPackages.length === 0) {
    return;
  }

  lines.push("## Young Packages", "");
  for (const finding of youngPackages.toSorted((left, right) => {
    const dateDelta = Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? "");
    if (Number.isFinite(dateDelta) && dateDelta !== 0) {
      return dateDelta;
    }
    return findingPackageKey(left).localeCompare(findingPackageKey(right));
  })) {
    lines.push(
      `- ${markdownCode(findingPackageKey(finding))}: published ${finding.publishedAt}; ` +
        `minimum release age ${finding.minimumReleaseAgeMinutes} minutes`,
    );
  }
  lines.push("");
}

function renderExoticSources(lines, exoticSources) {
  if (exoticSources.length === 0) {
    return;
  }

  lines.push("## Exotic Sources", "");
  for (const finding of exoticSources.toSorted((left, right) =>
    findingPackageKey(left).localeCompare(findingPackageKey(right)),
  )) {
    lines.push(`- ${markdownCode(findingPackageKey(finding))}: source ${finding.source}`);
  }
  lines.push("");
}

export function renderDependencyRiskMarkdownReport(report) {
  const lines = [
    "# Transitive Manifest Risk Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Scope",
    "",
    "This report inspects published package manifests for resolved packages in the lockfile. It looks for supply-chain risk signals such as floating dependency specs, lifecycle scripts, exotic sources, young packages, and missing publish time metadata. It is report-only.",
    "",
    "## Summary",
    "",
    `- Resolved package versions inspected: ${report.packageVersions}`,
    `- Findings: ${report.findingCount}`,
    `- Known findings: ${report.knownFindingCount}`,
    `- Metadata failures: ${report.metadataFailures.length}`,
    `- Unused known-risk entries: ${report.unusedExceptions.length}`,
    "",
    "## Findings By Type",
    "",
  ];
  for (const [type, count] of Object.entries(report.byType).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`- ${type}: ${count} (${report.knownByType[type] ?? 0} known)`);
  }
  lines.push("");

  renderCompleteEvidence(lines);
  renderKnownExceptionSummary(lines, report);

  if (report.findings.length > 0) {
    const rollups = collectMarkdownRollups(report.findings);
    renderPackageFindingSummary(lines, rollups.packageFindings);
    renderFloatingDependencyTargets(lines, rollups.floatingTargets);
    renderLifecycleScriptPackages(lines, rollups.lifecyclePackages);
    renderYoungPackages(lines, rollups.youngPackages);
    renderExoticSources(lines, rollups.exoticSources);
  }

  if (report.metadataFailures.length > 0) {
    lines.push("## Metadata Failures", "");
    for (const failure of report.metadataFailures) {
      lines.push(
        `- ${markdownCode(`${failure.packageName}@${failure.version}`)}: ${failure.error}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const renderMarkdownReport = renderDependencyRiskMarkdownReport;

function parseArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    exceptionsPath: DEFAULT_EXCEPTIONS_PATH,
    jsonPath: null,
    markdownPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--root") {
      options.rootDir = argv[++index];
      continue;
    }
    if (arg === "--exceptions") {
      options.exceptionsPath = argv[++index];
      continue;
    }
    if (arg === "--json") {
      options.jsonPath = argv[++index];
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = argv[++index];
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

async function writeArtifact(filePath, content) {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function runDependencyRiskReport({
  rootDir = process.cwd(),
  exceptionsPath = DEFAULT_EXCEPTIONS_PATH,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const lockfileText = await readFile(path.join(rootDir, "pnpm-lock.yaml"), "utf8");
  const payload = createBulkAdvisoryPayload(collectAllResolvedPackagesFromLockfile(lockfileText));
  const packageVersions = packageVersionsFromPayload(payload);
  const [{ exceptions, errors }, settings] = await Promise.all([
    loadKnownRiskExceptions(rootDir, exceptionsPath),
    loadWorkspaceRiskSettings(rootDir),
  ]);
  if (errors.length > 0) {
    const error = new Error(`Invalid dependency risk exceptions:\n${errors.join("\n")}`);
    error.errors = errors;
    throw error;
  }
  return createDependencyRiskReport({
    packageVersions,
    exceptions,
    now,
    minimumReleaseAgeMinutes: settings.minimumReleaseAgeMinutes,
    manifestLoader: ({ packageName, version }) =>
      fetchNpmManifest({
        packageName,
        version,
        fetchImpl,
        registryBaseUrl: resolveRegistryBaseUrl(),
      }),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await runDependencyRiskReport({
    rootDir: options.rootDir,
    exceptionsPath: options.exceptionsPath,
  });
  await writeArtifact(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeArtifact(options.markdownPath, renderMarkdownReport(report));
  const artifactHint = options.markdownPath ? ` See ${options.markdownPath}.` : "";
  process.stdout.write(
    `INFO transitive manifest risk report: inspected ${report.packageVersions} resolved ` +
      `package manifests; ${report.findingCount} report-only awareness findings, ` +
      `${report.knownFindingCount} known exceptions, ` +
      `${report.metadataFailures.length} metadata failures; release not blocked.${artifactHint}\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
