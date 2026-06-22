import {
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHECK_IDS = {
  configInvalid: "feeds/config-invalid",
  sourceMissing: "feeds/source-missing",
  sourceDuplicateId: "feeds/source-duplicate-id",
  sourceUrlInvalid: "feeds/source-url-invalid",
  sourceIntegrityInvalid: "feeds/source-integrity-invalid",
  sourceIntegrityMissing: "feeds/source-integrity-missing",
} as const;

export const FEEDS_CHECK_IDS = [
  CHECK_IDS.configInvalid,
  CHECK_IDS.sourceMissing,
  CHECK_IDS.sourceDuplicateId,
  CHECK_IDS.sourceUrlInvalid,
  CHECK_IDS.sourceIntegrityInvalid,
  CHECK_IDS.sourceIntegrityMissing,
] as const;

type FeedsCheckId = (typeof FEEDS_CHECK_IDS)[number];

export type FeedsDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

let registered = false;

export function registerFeedsDoctorChecks(host?: FeedsDoctorRegistrationHost): void {
  if (registered) {
    return;
  }
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  for (const check of feedsHealthChecks) {
    registerHealthCheck(check);
  }
  registered = true;
}

export function resetFeedsDoctorChecksForTest(): void {
  registered = false;
}

const feedsHealthChecks: readonly HealthCheck[] = FEEDS_CHECK_IDS.map((id) => ({
  id,
  kind: "plugin",
  description: feedsCheckDescription(id),
  source: "feeds",
  async detect(ctx) {
    return evaluateFeedsConfig(ctx).filter((finding) => finding.checkId === id);
  },
}));

function feedsCheckDescription(id: FeedsCheckId): string {
  switch (id) {
    case CHECK_IDS.configInvalid:
      return "The Feeds plugin configuration is well-formed.";
    case CHECK_IDS.sourceMissing:
      return "The enabled Feeds plugin has at least one configured source.";
    case CHECK_IDS.sourceDuplicateId:
      return "Feed source ids are unique.";
    case CHECK_IDS.sourceUrlInvalid:
      return "Feed source URLs are supported absolute URLs.";
    case CHECK_IDS.sourceIntegrityInvalid:
      return "Feed source integrity hashes use sha256:<hex> syntax.";
    case CHECK_IDS.sourceIntegrityMissing:
      return "Pinned feed sources declare an integrity hash.";
  }
  const exhaustive: never = id;
  return exhaustive;
}

export function evaluateFeedsConfig(
  ctx: Pick<HealthCheckContext, "cfg">,
): readonly HealthFinding[] {
  const config = ctx.cfg.plugins?.entries?.feeds?.config;
  const configPath = "plugins.entries.feeds.config";
  const configOcPath = "oc://openclaw.config/plugins/entries/feeds/config";

  if (config === undefined) {
    return [
      {
        checkId: CHECK_IDS.sourceMissing,
        severity: "warning",
        message: "The enabled Feeds plugin has no configured feed sources.",
        source: "feeds",
        path: configPath,
        ocPath: configOcPath,
        fixHint: "Add plugins.entries.feeds.config.sources with at least one feed source.",
      },
    ];
  }
  if (!isRecord(config)) {
    return [
      invalidConfigFinding({
        propertyPath: configPath,
        target: configOcPath,
        message: "plugins.entries.feeds.config must be an object.",
        fixHint: "Set plugins.entries.feeds.config to an object with a sources array.",
      }),
    ];
  }

  const findings: HealthFinding[] = [];
  const sources = config.sources;
  if (sources === undefined) {
    findings.push({
      checkId: CHECK_IDS.sourceMissing,
      severity: "warning",
      message: "The enabled Feeds plugin has no configured feed sources.",
      source: "feeds",
      path: `${configPath}.sources`,
      ocPath: `${configOcPath}/sources`,
      fixHint: "Add at least one feed source.",
    });
    return findings;
  }
  if (!Array.isArray(sources)) {
    findings.push(
      invalidConfigFinding({
        propertyPath: `${configPath}.sources`,
        target: `${configOcPath}/sources`,
        message: "plugins.entries.feeds.config.sources must be an array.",
        fixHint: "Set sources to an array of feed source objects.",
      }),
    );
    return findings;
  }
  if (sources.length === 0) {
    findings.push({
      checkId: CHECK_IDS.sourceMissing,
      severity: "warning",
      message: "The enabled Feeds plugin has an empty feed source list.",
      source: "feeds",
      path: `${configPath}.sources`,
      ocPath: `${configOcPath}/sources`,
      fixHint: "Add at least one feed source or disable the Feeds plugin.",
    });
    return findings;
  }

  const seenIds = new Map<string, number>();
  sources.forEach((source, index) => {
    findings.push(...evaluateFeedSource(source, index, seenIds));
  });
  return findings;
}

function evaluateFeedSource(
  source: unknown,
  index: number,
  seenIds: Map<string, number>,
): readonly HealthFinding[] {
  const sourcePath = `plugins.entries.feeds.config.sources[${index}]`;
  const sourceOcPath = `oc://openclaw.config/plugins/entries/feeds/config/sources/#${index}`;
  if (!isRecord(source)) {
    return [
      invalidConfigFinding({
        propertyPath: sourcePath,
        target: sourceOcPath,
        message: `Feed source ${index} must be an object.`,
        fixHint: "Replace this source with an object containing id and url.",
      }),
    ];
  }

  const findings: HealthFinding[] = [];
  const id = typeof source.id === "string" ? source.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) {
    findings.push(
      invalidConfigFinding({
        propertyPath: `${sourcePath}.id`,
        target: `${sourceOcPath}/id`,
        message: `Feed source ${index} must have a stable lowercase id.`,
        fixHint: "Use a lowercase id such as company-approved or clawhub-public.",
      }),
    );
  } else {
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      findings.push({
        checkId: CHECK_IDS.sourceDuplicateId,
        severity: "error",
        message: `Feed source id '${id}' duplicates sources[${previous}].`,
        source: "feeds",
        path: `${sourcePath}.id`,
        ocPath: `${sourceOcPath}/id`,
        fixHint: "Give each feed source a unique id.",
      });
    } else {
      seenIds.set(id, index);
    }
  }

  const url = typeof source.url === "string" ? source.url.trim() : "";
  if (!isSupportedFeedUrl(url)) {
    findings.push({
      checkId: CHECK_IDS.sourceUrlInvalid,
      severity: "error",
      message: `Feed source ${id || index} must use an absolute https:// or file:// URL.`,
      source: "feeds",
      path: `${sourcePath}.url`,
      ocPath: `${sourceOcPath}/url`,
      fixHint: "Use an absolute https:// URL for hosted feeds or file:// URL for local feeds.",
    });
  }

  const trust = source.trust;
  if (trust !== undefined && trust !== "unsigned" && trust !== "pinned") {
    findings.push(
      invalidConfigFinding({
        propertyPath: `${sourcePath}.trust`,
        target: `${sourceOcPath}/trust`,
        message: `Feed source ${id || index} has unsupported trust value '${formatUnknown(trust)}'.`,
        fixHint: 'Use trust "unsigned" or "pinned".',
      }),
    );
  }

  const integrity = source.integrity;
  if (integrity !== undefined && !isSha256Integrity(integrity)) {
    findings.push({
      checkId: CHECK_IDS.sourceIntegrityInvalid,
      severity: "error",
      message: `Feed source ${id || index} has an invalid integrity hash.`,
      source: "feeds",
      path: `${sourcePath}.integrity`,
      ocPath: `${sourceOcPath}/integrity`,
      fixHint: "Use sha256:<64 lowercase or uppercase hexadecimal characters>.",
    });
  }
  if (trust === "pinned" && integrity === undefined) {
    findings.push({
      checkId: CHECK_IDS.sourceIntegrityMissing,
      severity: "error",
      message: `Pinned feed source ${id || index} must declare an integrity hash.`,
      source: "feeds",
      path: `${sourcePath}.integrity`,
      ocPath: `${sourceOcPath}/integrity`,
      fixHint: 'Add integrity: "sha256:<hex>" or change trust to "unsigned".',
    });
  }

  return findings;
}

function invalidConfigFinding(params: {
  readonly propertyPath: string;
  readonly target: string;
  readonly message: string;
  readonly fixHint: string;
}): HealthFinding {
  return {
    checkId: CHECK_IDS.configInvalid,
    severity: "error",
    message: params.message,
    source: "feeds",
    path: params.propertyPath,
    ocPath: params.target,
    fixHint: params.fixHint,
  };
}

function isSupportedFeedUrl(value: string): boolean {
  if (value === "") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "file:";
  } catch {
    return false;
  }
}

function isSha256Integrity(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/iu.test(value);
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "<unprintable>";
  }
}
