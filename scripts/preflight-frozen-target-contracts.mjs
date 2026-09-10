#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const entryPath = "scripts/preflight-frozen-target-contracts.mjs";
const readerPath = "scripts/lib/frozen-target-source.mjs";
const toolingClosure = [
  entryPath,
  readerPath,
  "scripts/lib/docker-e2e-plan.mts",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/upgrade-survivor-policy.mjs",
  "scripts/lib/release-version.mjs",
  "scripts/lib/frozen-target-compat.sh",
  "scripts/resolve-frozen-codex-live-suite.mjs",
  "scripts/resolve-fs-safe-native-contract.mjs",
  "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
  "scripts/windows-cmd-helpers.mjs",
  "package.json",
  "pnpm-lock.yaml",
];
const maxRecordBytes = 256 * 1024;
const prefix = "OPENCLAW_FROZEN_TARGET_";
const shellOwners = {
  onboard: ["onboard_contract", [`${prefix}ONBOARD_CASES`]],
  "release-typed-onboarding": [
    "typed_onboarding_contract",
    [
      `${prefix}ONBOARD_SESSION_MEMORY_HOOK_MODE`,
      `${prefix}TYPED_ONBOARDING_SCENARIO_PATH`,
      `${prefix}TYPED_ONBOARDING_ASSERTIONS_PATH`,
      `${prefix}TYPED_ONBOARDING_MOCK_CONFIG_PATH`,
    ],
  ],
  "session-runtime-context": [
    "runtime_context_contract",
    [`${prefix}RUNTIME_CONTEXT_INPUT_MODE`, `${prefix}SESSION_REPAIR_MODE`],
  ],
  "mcp-code-mode-gateway": [
    "mcp_code_mode_contract",
    [`${prefix}MCP_MEMORY_CONFIG_MODE`, `${prefix}MCP_CODE_MODE_CATALOG_MODE`],
  ],
  "agent-bundle-mcp-tools": [
    "agent_bundle_mcp_contract",
    [`${prefix}AGENT_BUNDLE_MCP_MODE`, `${prefix}AGENT_BUNDLE_MCP_CLIENT_PATH`],
  ],
  "gateway-network": ["gateway_network_layout", [`${prefix}GATEWAY_NETWORK_LEGACY_LIB`]],
  plugins: [
    "plugin_harness_capabilities",
    [`${prefix}PLUGIN_UNINSTALL_MODE`, "OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT"],
  ],
  "live-cli-backend": ["live_cli_backend_package_mode", [`${prefix}LIVE_CLI_BACKEND_PACKAGE_MODE`]],
  "update-channel-switch": [
    "update_channel_dry_run_mode",
    [
      "OPENCLAW_UPDATE_CHANNEL_DRY_RUN_PACKAGE_COMPAT",
      "OPENCLAW_UPDATE_CHANNEL_DIRTY_BLOCK_EXIT_ZERO_COMPAT",
    ],
  ],
  "upgrade-survivor": [
    "upgrade_survivor_capabilities",
    ["OPENCLAW_FROZEN_UPGRADE_SURVIVOR_CLAWHUB_MODE"],
  ],
};

// These are the existing wrappers' generic resolver arguments, not new dialect rules.
const targetFiles = {
  "npm-onboard-channel-agent": [
    ["scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs"],
    ["scripts/e2e/lib/fixtures/mock-openai-config.mjs"],
  ],
  "codex-on-demand": [
    ["scripts/e2e/lib/codex-on-demand/assertions.mjs"],
    ["scripts/e2e/lib/codex-on-demand/doctor-checks.mjs", ""],
  ],
  "update-corrupt-plugin": [["scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh"]],
  "kitchen-sink-plugin": [["scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs"]],
};
const supportFiles = {
  "npm-onboard-channel-agent": [
    "agent-turn-output.mjs",
    "auth-profile-store-assertions.mjs",
    "env-limits.mjs",
    "text-file-utils.mjs",
    "openclaw-state-paths.mjs",
    "fixtures/common.mjs",
  ],
  "codex-on-demand": [
    "auth-profile-store-assertions.mjs",
    "codex-install-utils.mjs",
    "codex-release-package-assertions.mjs",
    "openclaw-state-paths.mjs",
    "plugin-index-sqlite.mjs",
    "fixtures/common.mjs",
    "env-limits.mjs",
    "text-file-utils.mjs",
  ],
  "kitchen-sink-plugin": [
    "env-limits.mjs",
    "openclaw-state-paths.mjs",
    "plugin-index-sqlite.mjs",
    "plugin-uninstall-assertions.mjs",
    "text-file-utils.mjs",
  ],
  "update-corrupt-plugin": [
    "plugins/fixtures.sh",
    "plugin-update/probe.mjs",
    "plugin-index-sqlite.mjs",
    "update-first-hop-package-fixtures.mjs",
    "release-scenarios/assertions.mjs",
    "agent-turn-output.mjs",
    "auth-profile-store-assertions.mjs",
    "fixtures/mock-openai-config.mjs",
    "env-limits.mjs",
    "text-file-utils.mjs",
    "openclaw-state-paths.mjs",
    "plugin-uninstall-assertions.mjs",
    "release-assertion-files.mjs",
    "package-compat.mjs",
    "plugin-update/consent-scenario.mjs",
    "plugin-update/process-observer.mjs",
  ],
};

function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function text(value, label, limit = 4096) {
  if (typeof value !== "string" || value.length > limit) {
    throw new Error(`invalid ${label}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) {
      throw new Error(`invalid ${label}`);
    }
  }
  return value;
}

function strings(value, label) {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`invalid ${label}`);
  }
  return [...new Set(value.map((entry) => text(entry, label, 256)))].toSorted();
}

function boolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error("expected boolean selection");
  }
  return value;
}

function required(source, path) {
  const content = source.readText(path);
  if (content === null) {
    throw new Error(`missing required contract file: ${path}`);
  }
  return content;
}

function verifyToolingFile(path, committed) {
  const file = join(ownRoot, path);
  let info;
  try {
    info = lstatSync(file);
    if (!info.isFile() || realpathSync.native(file) !== file) {
      throw new Error("not an owned regular file");
    }
  } catch {
    throw new Error(`tooling closure requires an owned regular file: ${path}`);
  }
  if (info.size !== committed.length || !readFileSync(file).equals(committed)) {
    throw new Error(`tooling closure does not match committed source: ${path}`);
  }
}

function verifyReaderBootstrap(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("tooling source requires a full lowercase commit SHA");
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const deadline = Date.now() + 30_000;
  const git = (...args) => {
    try {
      const timeout = deadline - Date.now();
      if (timeout <= 0) {
        throw new Error("bootstrap read limit exceeded");
      }
      // Unsupported no-lazy-fetch flags fail closed before the reader can load.
      return execFileSync(
        "git",
        ["--no-lazy-fetch", "--no-replace-objects", "-C", ownRoot, ...args],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
    } catch {
      throw new Error("unable to read committed tooling bootstrap");
    }
  };
  // The launched bootstrap and checkout are trusted; this binds their working
  // bytes, not hostile bootstrap code or concurrent writers. The verified reader
  // still owns Git version, HEAD, commit/tree hashes, and all other source reads.
  for (const path of [entryPath, readerPath]) {
    const entry = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(
      git("ls-tree", "-z", sha, "--", path).toString("utf8"),
    );
    if (!entry || entry[3] !== path) {
      throw new Error(`tooling bootstrap requires a regular committed file: ${path}`);
    }
    const content = git("cat-file", "blob", entry[2]);
    const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    if (oid !== entry[2]) {
      throw new Error("unable to read committed tooling bootstrap (object hash mismatch)");
    }
    verifyToolingFile(path, content);
  }
}

function consumerForLane(name) {
  if (/^(published-upgrade-survivor|update-migration)(-|$)/u.test(name)) {
    return "upgrade-survivor";
  }
  if (name.startsWith("npm-onboard-")) {
    return "npm-onboard-channel-agent";
  }
  if (name === "live-mcp-code-mode-gateway") {
    return "mcp-code-mode-gateway";
  }
  if (name === "live-gateway") {
    return "live-cli-backend";
  }
  if (
    name === "mcp-channels" ||
    name === "kitchen-sink-rpc" ||
    /^bundled-plugin-install-uninstall(-|$)/u.test(name)
  ) {
    return "plugins";
  }
  return Object.hasOwn(shellOwners, name) || Object.hasOwn(targetFiles, name) ? name : null;
}

async function preflightFrozenTargetContracts(input) {
  object(
    input,
    [
      "version",
      "repository",
      "selected",
      "tooling",
      "allowFrozenTargetScenarioOmissions",
      "selection",
    ],
    "admission request",
  );
  if (input.version !== 1 || input.repository !== "openclaw/openclaw") {
    throw new Error("invalid admission identity");
  }
  const allow = boolean(input.allowFrozenTargetScenarioOmissions);
  const roots = {};
  const sources = {};
  for (const key of ["selected", "tooling"]) {
    object(input[key], ["root", "sha"], `${key} identity`);
    roots[key] = realpathSync(text(input[key].root, `${key} root`));
  }
  if (roots.tooling !== ownRoot) {
    throw new Error("tooling identity does not own this evaluator");
  }
  verifyReaderBootstrap(input.tooling.sha);
  const { createFrozenTargetSource } = await import("./lib/frozen-target-source.mjs");
  for (const key of ["selected", "tooling"]) {
    sources[key] = createFrozenTargetSource(roots[key], input[key].sha);
  }
  const toolingRecipes = sources.tooling.readDirectory(
    "scripts/e2e/lib/upgrade-survivor/config-recipe",
  );
  if (toolingRecipes === null) {
    throw new Error("missing required tooling recipe directory");
  }
  for (const path of [...toolingClosure, ...toolingRecipes]) {
    verifyToolingFile(path, Buffer.from(required(sources.tooling, path), "utf8"));
  }
  const {
    DEFAULT_LIVE_RETRIES,
    parseLaneSelection,
    parseLiveMode,
    parseProfile,
    resolveDockerE2ePlan,
  } = await import("./lib/docker-e2e-plan.mts");
  const { classifyReleaseTrain, parseReleaseVersion } = await import("./lib/release-version.mjs");
  const { resolveFrozenCodexCompatibility } = await import("./resolve-frozen-codex-live-suite.mjs");
  const { resolveFsSafeNativeContract } = await import("./resolve-fs-safe-native-contract.mjs");
  if (allow && input.selected.sha === input.tooling.sha) {
    throw new Error("frozen omissions require distinct identities");
  }
  const selection = object(
    input.selection,
    ["docker", "consumers", "codexSuites", "fsSafeNative"],
    "selection",
  );
  const consumers = new Set(strings(selection.consumers ?? [], "consumers"));
  for (const consumer of consumers) {
    if (!Object.hasOwn(shellOwners, consumer) && !Object.hasOwn(targetFiles, consumer)) {
      throw new Error(`unknown selected contract: ${consumer}`);
    }
  }
  const codexSuites = strings(selection.codexSuites ?? [], "Codex suites");
  if (
    codexSuites.some(
      (suite) => !/^live-codex-harness(?:-gpt56-(?:sol|luna|terra))?-docker$/u.test(suite),
    )
  ) {
    throw new Error("unknown selected Codex suite");
  }
  const fsSafeNative = boolean(selection.fsSafeNative);
  let docker;
  let normalizedDocker;
  if (selection.docker !== undefined) {
    const value = object(
      selection.docker,
      [
        "lanes",
        "profile",
        "releaseProfile",
        "chunk",
        "planReleaseAll",
        "liveMode",
        "includeOpenWebUI",
        "baselines",
        "scenarios",
      ],
      "Docker selection",
    );
    normalizedDocker = {
      lanes: parseLaneSelection(strings(value.lanes ?? [], "Docker lanes").join(",")),
      profile: parseProfile(text(value.profile ?? "all", "Docker profile")),
      releaseProfile: text(value.releaseProfile ?? "full", "release profile"),
      chunk: text(value.chunk ?? "core", "release chunk"),
      planReleaseAll: boolean(value.planReleaseAll),
      liveMode: parseLiveMode(text(value.liveMode ?? "all", "live mode")),
      includeOpenWebUI: boolean(value.includeOpenWebUI),
      baselines: text(value.baselines ?? "", "baselines"),
      scenarios: text(value.scenarios ?? "", "scenarios"),
    };
    const result = resolveDockerE2ePlan({
      allowFrozenTargetScenarioOmissions: allow,
      frozenTarget: { mode: "inert", source: sources.selected },
      includeOpenWebUI: normalizedDocker.includeOpenWebUI,
      liveMode: normalizedDocker.liveMode,
      liveRetries: DEFAULT_LIVE_RETRIES,
      orderLanes: (lanes) => lanes,
      planReleaseAll: normalizedDocker.planReleaseAll,
      profile: normalizedDocker.profile,
      releaseChunk: normalizedDocker.chunk,
      releaseProfile: normalizedDocker.releaseProfile,
      selectedLaneNames: normalizedDocker.lanes,
      upgradeSurvivorBaselines: normalizedDocker.baselines,
      upgradeSurvivorScenarios: normalizedDocker.scenarios,
    });
    docker = {
      lanes: result.scheduledLanes.map((lane) => lane.name),
      omitted: result.omittedUnsupportedLaneNames,
      status: result.scheduledLanes.length ? "ADMITTED" : "NOT RUN",
    };
    for (const lane of docker.lanes) {
      const consumer = consumerForLane(lane);
      if (consumer) {
        consumers.add(consumer);
      }
    }
  }
  const env = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: allow ? "1" : "0",
    OPENCLAW_SELECTED_SHA: input.selected.sha,
    OPENCLAW_TOOLING_SHA: input.tooling.sha,
  };
  const deadline = Date.now() + 60_000;
  const shell = (command, args) =>
    execFileSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `set -euo pipefail; source "$1"; shift; ${command}`,
        "admission",
        join(roots.tooling, "scripts/lib/frozen-target-compat.sh"),
        ...args,
      ],
      {
        cwd: roots.tooling,
        env,
        encoding: "utf8",
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: maxRecordBytes,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  const rootOrder = ["tooling", "selected"].toSorted((a, b) => roots[b].length - roots[a].length);
  const bindPath = (absolute) => {
    if (!absolute) {
      return null;
    }
    for (const key of rootOrder) {
      const path = relative(roots[key], absolute);
      if (!path.startsWith("../") && path !== ".." && !path.startsWith("/")) {
        required(sources[key], path);
        return { source: key, path };
      }
    }
    throw new Error("resolved contract path escaped its source");
  };
  const contracts = [];
  for (const consumer of [...consumers].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const contract = { consumer, status: "ADMITTED", modes: {}, files: [] };
    const owner = shellOwners[consumer === "kitchen-sink-plugin" ? "plugins" : consumer];
    if (owner) {
      const [fn, names] = owner;
      const output = shell(
        `openclaw_resolve_frozen_${fn} "$1" "$2"; shift 2; for key in "$@"; do printf "%s\\0" "\${!key}"; done`,
        [roots.selected, roots.tooling, ...names],
      ).split("\0");
      if (output.pop() !== "" || output.length !== names.length) {
        throw new Error("invalid contract result");
      }
      for (const [index, name] of names.entries()) {
        const value = output[index];
        if (name.endsWith("_PATH")) {
          const absolute = name.endsWith("_CLIENT_PATH")
            ? join(allow ? roots.selected : roots.tooling, value)
            : value;
          contract.files.push(bindPath(absolute));
        } else if (name.endsWith("_LIB")) {
          if (value) {
            const path = relative(roots.selected, value);
            required(sources.selected, `${path}/gateway-network/client.mjs`);
            contract.modes[name] = path;
          }
        } else {
          contract.modes[name] = text(value, "contract mode", 1024);
        }
      }
    }
    for (const [path, missing] of targetFiles[consumer] ?? []) {
      const args = [roots.selected, path, join(roots.tooling, path)];
      if (missing !== undefined) {
        args.push(missing);
      }
      const value = shell('openclaw_resolve_frozen_target_file "$@"', args).trimEnd();
      contract.files.push(bindPath(value));
    }
    if (consumer === "codex-on-demand") {
      const path = "extensions/codex/package.json";
      required(sources.selected, path);
      contract.files.push({ source: "selected", path });
    }
    for (const path of supportFiles[consumer] ?? []) {
      required(sources.tooling, `scripts/e2e/lib/${path}`);
    }
    if (
      ["npm-onboard-channel-agent", "codex-on-demand", "update-corrupt-plugin"].includes(consumer)
    ) {
      required(sources.tooling, "scripts/lib/record-shared.mjs");
    }
    if (consumer === "update-corrupt-plugin") {
      required(sources.tooling, "scripts/lib/update-compat-contract.mjs");
      required(sources.tooling, "scripts/lib/openclaw-e2e-instance.sh");
      required(sources.tooling, "scripts/lib/direct-run.mjs");
    }
    if (consumer === "upgrade-survivor" && allow) {
      const version = JSON.parse(required(sources.selected, "package.json")).version;
      const parsed = typeof version === "string" ? parseReleaseVersion(version) : null;
      if (!parsed) {
        throw new Error("selected upgrade target has an invalid release version");
      }
      const train = classifyReleaseTrain(parsed);
      if (train === "unsupported-extended-stable-correction") {
        throw new Error("unsupported extended-stable correction");
      }
      contract.modes.releaseTrain = train;
      if (train === "extended-stable") {
        const dir = "scripts/e2e/lib/upgrade-survivor";
        const selected = shell('openclaw_resolve_frozen_target_file "$@"', [
          roots.selected,
          dir,
        ]).trimEnd();
        if (!selected) {
          throw new Error("selected extended-stable target lacks its scenario");
        }
        for (const file of ["run.sh", "assertions.mjs", "probe-gateway.mjs"]) {
          required(sources.selected, `${dir}/${file}`);
        }
        const files = sources.selected.readDirectory(dir);
        const recipes = ["config-recipe.mjs", "config-recipe.mts"].filter((file) =>
          files.includes(`${dir}/${file}`),
        );
        if (recipes.length !== 1) {
          throw new Error("missing or ambiguous shipped survivor recipe");
        }
        const recipeFiles = sources.selected.readDirectory(`${dir}/config-recipe`);
        if (!recipeFiles?.length) {
          throw new Error("missing shipped survivor recipe data");
        }
        for (const section of [
          "agents",
          "channels-discord",
          "channels-feishu",
          "channels-matrix",
          "channels-telegram",
          "channels-whatsapp",
          "gateway",
          "models-openai",
          "plugins-configured-installs",
          "plugins-feishu",
          "plugins",
          "skills",
        ]) {
          required(sources.selected, `${dir}/config-recipe/${section}.json`);
        }
        for (const path of [
          "scripts/lib/npm-publish-plan.mjs",
          "scripts/windows-cmd-helpers.mjs",
          "scripts/e2e/lib/plugin-index-sqlite.mjs",
          "scripts/e2e/lib/env-limits.mjs",
          "scripts/e2e/lib/text-file-utils.mjs",
        ]) {
          const selectedFile = shell('openclaw_resolve_frozen_target_file "$@"', [
            roots.selected,
            path,
          ]).trimEnd();
          if (!selectedFile) {
            throw new Error(`missing shipped survivor support: ${path}`);
          }
          contract.files.push(bindPath(selectedFile));
        }
      }
    }
    contracts.push(contract);
  }
  for (const suiteId of codexSuites) {
    const result = allow
      ? resolveFrozenCodexCompatibility({
          suiteId,
          readSource: (path) => sources.selected.readText(path),
        })
      : { runLane: true };
    contracts.push({
      consumer: suiteId,
      status: result.runLane ? "ADMITTED" : "NOT RUN",
      ...(result.model ? { model: result.model } : {}),
    });
  }
  if (fsSafeNative) {
    contracts.push({
      consumer: "fs-safe-native",
      mode: resolveFsSafeNativeContract({
        selectedSha: input.selected.sha,
        workflowSha: input.tooling.sha,
        allowFrozenSource: allow,
        containingBranches: () =>
          sources.selected.containingBranches("refs/remotes/origin/extended-stable"),
        readSource: (path) => sources.selected.readText(path),
      }),
    });
  }
  const record = {
    version: 1,
    repository: input.repository,
    selectedSha: input.selected.sha,
    toolingSha: input.tooling.sha,
    selection: {
      consumers: [...consumers].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      codexSuites,
      fsSafeNative,
      allowFrozenTargetScenarioOmissions: allow,
      ...(normalizedDocker ? { docker: normalizedDocker } : {}),
    },
    contracts,
    ...(docker ? { docker } : {}),
    sources: {
      selected: sources.selected.blobIdentities(),
      tooling: sources.tooling.blobIdentities(),
    },
  };
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > maxRecordBytes) {
    throw new Error("admission record exceeds limit");
  }
  return { ...record, digest: createHash("sha256").update(serialized).digest("hex") };
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain =
      realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1]);
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}

if (invokedAsMain) {
  try {
    const [file, ...extra] = process.argv.slice(2);
    if (!file || extra.length || !statSync(file).isFile() || statSync(file).size > 64 * 1024) {
      throw new Error("expected one bounded admission request file");
    }
    const result = await preflightFrozenTargetContracts(JSON.parse(readFileSync(file, "utf8")));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`frozen admission: ${error.message}`);
    process.exitCode = 1;
  }
}
