import { parseArgs } from "node:util";
import type { ReleasePublishGate } from "./release-publish-gates.mts";

export type ReleasePublishPreflightOptions = {
  repo: string;
  tag: string;
  fullReleaseValidationRunId: string;
  fullReleaseValidationRunAttempt?: string | number;
  preflightRunId?: string;
  npmDistTag: string;
  pluginPublishScope: "selected" | "all-publishable";
  plugins?: string;
  stableSoakWaiver?: string;
  laneWaiver?: string;
  workflowRef: string;
  releaseProfile?: string;
  publishOpenclawNpm?: boolean;
  openclawNpmResumeRunId?: string;
  pluginSdkApiAcknowledgement?: string;
  windowsNodeTag?: string;
  windowsNodeInstallerDigests?: string;
  npmTelegramRunId?: string;
  publicationRoute?: "normal" | "prepared";
};
export type PreflightReport = { rows: ReleasePublishGate[]; command: string; failed: boolean };
function quote(value: string): string {
  return /^[a-zA-Z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildReleasePublishDispatchCommand(
  options: ReleasePublishPreflightOptions,
  attempt: string,
  workflowRef: string,
  resume: string,
) {
  const fields = {
    tag: options.tag,
    preflight_run_id: options.preflightRunId ?? options.fullReleaseValidationRunId,
    full_release_validation_run_id: options.fullReleaseValidationRunId,
    full_release_validation_run_attempt: attempt,
    npm_dist_tag: options.npmDistTag,
    plugin_publish_scope: options.pluginPublishScope,
    plugins: options.plugins,
    stable_soak_waiver: options.stableSoakWaiver,
    lane_waiver: options.laneWaiver,
    release_profile: options.releaseProfile ?? "from-validation",
    publish_openclaw_npm: String(options.publishOpenclawNpm !== false),
    openclaw_npm_resume_run_id: resume,
    plugin_sdk_api_acknowledgement: options.pluginSdkApiAcknowledgement,
    windows_node_tag: options.windowsNodeTag,
    windows_node_installer_digests: options.windowsNodeInstallerDigests,
    npm_telegram_run_id: options.npmTelegramRunId,
  };
  return [
    `gh workflow run openclaw-release-publish.yml --repo ${quote(options.repo)} --ref ${quote(workflowRef)}`,
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `  -f ${quote(`${key}=${value}`)}`),
  ].join(" \\\n");
}

export function formatReleasePublishPreflight(
  report: PreflightReport,
  options: { includeCommand?: boolean } = {},
) {
  const cell = (value: string) => value.replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");
  return [
    "| Status | Gate | Observation | Remediation |",
    "| --- | --- | --- | --- |",
    ...report.rows.map(
      (row) =>
        `| ${row.status} | ${cell(row.id)} | ${cell(row.message)} | ${cell(row.remediation || "—")} |`,
    ),
    "",
    report.failed
      ? "Preflight failed. Resolve FAIL rows before dispatch."
      : "No known blocking gate failed. Resolve WARN rows before dispatch where applicable.",
    ...(options.includeCommand === false
      ? []
      : ["", "Dispatch after resolving the table:", "", "```sh", report.command, "```"]),
  ].join("\n");
}

export function parsePublishPreflightArgs(argv: string[]) {
  const strings = [
    "repo",
    "tag",
    "full-release-validation-run-id",
    "full-release-validation-run-attempt",
    "preflight-run-id",
    "npm-dist-tag",
    "plugin-publish-scope",
    "plugins",
    "stable-soak-waiver",
    "lane-waiver",
    "workflow-ref",
    "release-profile",
    "publish-openclaw-npm",
    "openclaw-npm-resume-run-id",
    "plugin-sdk-api-acknowledgement",
    "windows-node-tag",
    "windows-node-installer-digests",
    "npm-telegram-run-id",
  ];
  const optionDefinitions: Record<string, { type: "string" | "boolean" }> = {
    ...Object.fromEntries(strings.map((key) => [key, { type: "string" as const }])),
    help: { type: "boolean" },
    json: { type: "boolean" },
  };
  const parsed = parseArgs({ args: argv, options: optionDefinitions, strict: true });
  if (parsed.values.help) {
    console.log(
      "Usage: pnpm release:publish-preflight --tag <tag> --full-release-validation-run-id <id> --workflow-ref <protected-publish-tag> [options]\n\nRead-only: evaluates publication gates and prints the exact dispatch command.\n" +
        strings.map((key) => `  --${key} <value>`).join("\n") +
        "\n  --json  Emit the report as JSON.\n\nDefaults: repo=openclaw/openclaw, npm-dist-tag=beta, plugin-publish-scope=all-publishable, publish-openclaw-npm=true, release-profile=from-validation.\npreflight-run-id defaults to the full validation run when it owns a qualified npm preflight.",
    );
    return undefined;
  }
  const value = (key: string, fallback = "") => String(parsed.values[key] ?? fallback);
  if (!value("tag") || !value("workflow-ref")) {
    throw new Error("--tag and --workflow-ref are required.");
  }
  if (!["true", "false"].includes(value("publish-openclaw-npm", "true"))) {
    throw new Error("--publish-openclaw-npm must be true or false.");
  }
  const scope = value("plugin-publish-scope", "all-publishable");
  if (scope !== "selected" && scope !== "all-publishable") {
    throw new Error("Invalid --plugin-publish-scope.");
  }
  const options: ReleasePublishPreflightOptions = {
    repo: value("repo", "openclaw/openclaw"),
    tag: value("tag"),
    fullReleaseValidationRunId: value("full-release-validation-run-id"),
    fullReleaseValidationRunAttempt: value("full-release-validation-run-attempt"),
    preflightRunId: value("preflight-run-id") || undefined,
    npmDistTag: value("npm-dist-tag", "beta"),
    pluginPublishScope: scope,
    plugins: value("plugins"),
    stableSoakWaiver: value("stable-soak-waiver"),
    laneWaiver: value("lane-waiver"),
    workflowRef: value("workflow-ref"),
    releaseProfile: value("release-profile", "from-validation"),
    publishOpenclawNpm: value("publish-openclaw-npm", "true") === "true",
    openclawNpmResumeRunId: value("openclaw-npm-resume-run-id"),
    pluginSdkApiAcknowledgement: value("plugin-sdk-api-acknowledgement"),
    windowsNodeTag: value("windows-node-tag"),
    windowsNodeInstallerDigests: value("windows-node-installer-digests"),
    npmTelegramRunId: value("npm-telegram-run-id"),
  };
  return { options, json: parsed.values.json };
}
