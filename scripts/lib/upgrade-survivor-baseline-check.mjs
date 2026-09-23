import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseUpgradeSurvivorBaselineSpecs,
  parseUpgradeSurvivorScenarios,
} from "./upgrade-survivor-policy.mjs";

const survivorLanes = new Set(["published-upgrade-survivor", "update-migration"]);

function probeBaseline(baseline) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-baseline-check-"));
  const prefix = path.join(root, "prefix");
  const config = path.join(root, "openclaw.json");
  const npmrc = path.join(root, "npmrc");
  const checks = [];
  try {
    writeFileSync(config, JSON.stringify({ gateway: { mode: "local" } }));
    writeFileSync(npmrc, "");
    // Published bytes must never resolve through the candidate registry or the
    // operator's npm/OpenClaw configuration. Nothing survives this probe's home.
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      CI: "true",
      npm_config_prefix: prefix,
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_userconfig: npmrc,
      npm_config_globalconfig: path.join(root, "global-npmrc"),
      npm_config_registry: "https://registry.npmjs.org",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_NO_AUTO_UPDATE: "1",
    };
    const cli = path.join(prefix, "bin", "openclaw");
    for (const [command, args, timeout] of [
      ["npm", ["install", "-g", "--prefix", prefix, baseline, "--no-fund", "--no-audit"], 600_000],
      [cli, ["--version"], 60_000],
      // Version, help, and config reads can bypass full CLI startup. Apply a
      // synthetic setting to exercise scenario setup without starting a Gateway.
      [cli, ["config", "set", "gateway.mode", "local"], 60_000],
    ]) {
      const result = spawnSync(command, args, {
        cwd: root,
        env,
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      const label = command === "npm" ? "npm install" : `openclaw ${args.join(" ")}`;
      const error = [result.error?.message, result.stderr, result.stdout]
        .filter(Boolean)
        .join("\n")
        .slice(-16_384);
      checks.push({
        command: label,
        exitCode: result.status,
        signal: result.signal,
        output: error,
      });
      if (result.status !== 0) {
        const status = command === "npm" || result.error || result.signal ? "failed" : "skipped";
        return {
          status,
          reason: `${status === "skipped" ? "unusable published baseline" : "baseline precheck failed"}: ${label} (exit ${result.status}, signal ${result.signal})`,
          error,
          checks,
        };
      }
    }
    return { status: "usable", checks };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function checkUpgradeSurvivorBaselines(
  groups,
  { evidenceDir, baselines, baseline, scenarios },
) {
  const selections = new Map();
  const groupBaselines = new Map();
  for (const group of groups) {
    const lanes = group.docker_lanes.split(/\s+/u).filter((lane) => survivorLanes.has(lane));
    if (lanes.length === 0) {
      continue;
    }
    const specs = parseUpgradeSurvivorBaselineSpecs(
      group.published_upgrade_survivor_baselines || baselines || baseline || "openclaw@latest",
    );
    const requested = parseUpgradeSurvivorScenarios(
      group.published_upgrade_survivor_scenarios || scenarios || "base",
    );
    groupBaselines.set(group, specs);
    for (const spec of specs) {
      const entry = selections.get(spec) ?? { baseline: spec, groups: [], scenarios: [] };
      entry.groups.push(group.label);
      entry.scenarios = [...new Set([...entry.scenarios, ...requested])];
      selections.set(spec, entry);
    }
  }
  mkdirSync(evidenceDir, { recursive: true });
  const results = [...selections.values()].map((selection) => {
    console.error(`Checking published upgrade baseline ${selection.baseline}`);
    return Object.assign(selection, probeBaseline(selection.baseline));
  });
  writeFileSync(
    path.join(evidenceDir, "summary.json"),
    `${JSON.stringify({ baselines: results }, null, 2)}\n`,
  );
  const summary = [
    "### Published upgrade baseline checks",
    "",
    "Usable means startup checked; upgrade scenarios still require their own results.",
  ];
  for (const result of results) {
    summary.push(
      "",
      `- ${result.baseline}: **${result.status}**${result.reason ? ` — ${result.reason}` : ""}`,
      `  Scenarios: ${result.scenarios.join(", ")}`,
    );
    if (result.error) {
      summary.push(
        "",
        "<pre>",
        result.error.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
        "</pre>",
      );
    }
  }
  writeFileSync(path.join(evidenceDir, "summary.md"), `${summary.join("\n")}\n`);
  if (results.some((result) => result.status === "failed")) {
    throw new Error(`Published baseline precheck failed; see ${evidenceDir}/summary.json`);
  }
  const unusable = new Set(
    results.filter((result) => result.status === "skipped").map((result) => result.baseline),
  );
  return groups.flatMap((group) => {
    if (!groupBaselines.get(group)?.some((spec) => unusable.has(spec))) {
      return [group];
    }
    const remaining = group.docker_lanes.split(/\s+/u).filter((lane) => !survivorLanes.has(lane));
    return remaining.length ? [{ ...group, docker_lanes: remaining.join(" ") }] : [];
  });
}
