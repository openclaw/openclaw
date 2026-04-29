#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/lib/docker-e2e-logs.sh

OPENCLAW_ENTRY="$(openclaw_e2e_resolve_entrypoint)"
export OPENCLAW_ENTRY

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

run_expect_failure() {
  local label="$1"
  shift
  local output_file="/tmp/kitchen-sink-expected-failure-${label}.txt"
  set +e
  "$@" >"$output_file" 2>&1
  local status="$?"
  set -e
  cat "$output_file"
  if [ "$status" -eq 0 ]; then
    echo "Expected ${label} to fail, but it succeeded." >&2
    exit 1
  fi
  node - "$output_file" <<'NODE'
const fs = require("node:fs");

const output = fs.readFileSync(process.argv[2], "utf8");
const source = process.env.KITCHEN_SINK_SOURCE;
const spec = process.env.KITCHEN_SINK_SPEC;
const displayedSpec = source === "npm" ? spec.replace(/^npm:/u, "") : spec;
const expected =
  source === "clawhub"
    ? /Version not found on ClawHub|ClawHub .* failed \(404\)|version.*not found/iu
    : /No matching version|ETARGET|notarget|npm (?:error|ERR!)/iu;
if (!output.includes(displayedSpec)) {
  throw new Error(`expected failure output to mention ${displayedSpec}`);
}
if (!expected.test(output)) {
  throw new Error(`unexpected ${source} beta failure output:\n${output}`);
}
console.log("ok");
NODE
}

start_kitchen_sink_clawhub_fixture_server() {
  local fixture_dir="$1"
  local server_log="$fixture_dir/clawhub-fixture.log"
  local server_port_file="$fixture_dir/clawhub-fixture-port"
  local server_pid_file="$fixture_dir/clawhub-fixture-pid"

  node - "$server_port_file" <<'NODE' >"$server_log" 2>&1 &
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

const portFile = process.argv[2];
const requireFromApp = createRequire(path.join(process.cwd(), "package.json"));
const JSZip = requireFromApp("jszip");
const packageName = "openclaw-kitchen-sink";
const pluginId = "openclaw-kitchen-sink-fixture";
const version = "0.1.3";

async function main() {
  const zip = new JSZip();
  zip.file(
    "package/package.json",
    `${JSON.stringify(
      {
        name: packageName,
        version,
        openclaw: { extensions: ["./index.js"] },
      },
      null,
      2,
    )}\n`,
    { date: new Date(0) },
  );
  zip.file(
    "package/index.js",
    `module.exports = {
  id: "${pluginId}",
  name: "OpenClaw Kitchen Sink",
  register(api) {
    api.registerProvider({
      id: "kitchen-sink-provider",
      label: "Kitchen Sink Provider",
      docsPath: "/providers/kitchen-sink",
      auth: [],
    });
    api.registerChannel({
      plugin: {
        id: "kitchen-sink-channel",
        meta: {
          id: "kitchen-sink-channel",
          label: "Kitchen Sink Channel",
          selectionLabel: "Kitchen Sink",
          docsPath: "/channels/kitchen-sink",
          blurb: "Kitchen sink ClawHub fixture channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};
`,
    { date: new Date(0) },
  );
  zip.file(
    "package/openclaw.plugin.json",
    `${JSON.stringify(
      {
        id: pluginId,
        name: "OpenClaw Kitchen Sink",
        channels: ["kitchen-sink-channel"],
        providers: ["kitchen-sink-provider"],
        configSchema: {
          type: "object",
          properties: {},
        },
      },
      null,
      2,
    )}\n`,
    { date: new Date(0) },
  );

  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const sha256hash = crypto.createHash("sha256").update(archive).digest("hex");
  const packageDetail = {
    package: {
      name: packageName,
      displayName: "OpenClaw Kitchen Sink",
      family: "code-plugin",
      runtimeId: pluginId,
      channel: "official",
      isOfficial: true,
      summary: "Kitchen sink plugin fixture for prerelease CI.",
      ownerHandle: "openclaw",
      createdAt: 0,
      updatedAt: 0,
      latestVersion: version,
      tags: { latest: version },
      capabilityTags: ["test-fixture"],
      executesCode: true,
      compatibility: {
        pluginApiRange: ">=2026.4.11",
        minGatewayVersion: "2026.4.11",
      },
      capabilities: {
        executesCode: true,
        runtimeId: pluginId,
        capabilityTags: ["test-fixture"],
        channels: ["kitchen-sink-channel"],
        providers: ["kitchen-sink-provider"],
      },
      verification: {
        tier: "source-linked",
        sourceRepo: "https://github.com/openclaw/kitchen-sink",
        hasProvenance: false,
        scanStatus: "passed",
      },
    },
  };
  const versionDetail = {
    package: {
      name: packageName,
      displayName: "OpenClaw Kitchen Sink",
      family: "code-plugin",
    },
    version: {
      version,
      createdAt: 0,
      changelog: "Fixture package for kitchen-sink plugin prerelease CI.",
      distTags: ["latest"],
      sha256hash,
      compatibility: packageDetail.package.compatibility,
      capabilities: packageDetail.package.capabilities,
      verification: packageDetail.package.verification,
    },
  };

  const json = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(`${JSON.stringify(value)}\n`);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("method not allowed");
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}`) {
      json(response, packageDetail);
      return;
    }
    if (
      url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${version}`
    ) {
      json(response, versionDetail);
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/versions/beta`) {
      json(response, { error: "version not found" }, 404);
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/download`) {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      });
      response.end(archive);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${url.pathname}`);
  });

  server.listen(0, "127.0.0.1", () => {
    require("node:fs").writeFileSync(portFile, String(server.address().port));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
  local server_pid="$!"
  echo "$server_pid" >"$server_pid_file"

  for _ in $(seq 1 100); do
    if [[ -s "$server_port_file" ]]; then
      export OPENCLAW_CLAWHUB_URL="http://127.0.0.1:$(cat "$server_port_file")"
      trap 'if [[ -f "'"$server_pid_file"'" ]]; then kill "$(cat "'"$server_pid_file"'")" 2>/dev/null || true; fi' EXIT
      return 0
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      cat "$server_log"
      return 1
    fi
    sleep 0.1
  done

  cat "$server_log"
  echo "Timed out waiting for kitchen-sink ClawHub fixture server." >&2
  return 1
}

scan_logs_for_unexpected_errors() {
  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const roots = ["/tmp", path.join(process.env.HOME, ".openclaw")];
const files = [];
const visit = (entry) => {
  if (!fs.existsSync(entry)) {
    return;
  }
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) {
      visit(path.join(entry, child));
    }
    return;
  }
  if (/\.(?:log|jsonl)$/u.test(entry) || /openclaw-kitchen-sink-/u.test(path.basename(entry))) {
    if (entry.includes("/.npm/_logs/")) {
      return;
    }
    files.push(entry);
  }
};
for (const root of roots) {
  visit(root);
}

const deny = [
  /\buncaught exception\b/iu,
  /\bunhandled rejection\b/iu,
  /\bfatal\b/iu,
  /\bpanic\b/iu,
  /\blevel["']?\s*:\s*["']error["']/iu,
  /\[(?:error|ERROR)\]/u,
];
const allow = [
  /0 errors?/iu,
  /expected no diagnostics errors?/iu,
  /diagnostics errors?:\s*$/iu,
];
const findings = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (allow.some((pattern) => pattern.test(line))) {
      return;
    }
    if (deny.some((pattern) => pattern.test(line))) {
      findings.push(`${file}:${index + 1}: ${line}`);
    }
  });
}
if (findings.length > 0) {
  throw new Error(`unexpected error-like log lines:\n${findings.join("\n")}`);
}
console.log(`log scan passed (${files.length} file(s))`);
NODE
}

configure_kitchen_sink_runtime() {
  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.env.KITCHEN_SINK_ID;
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
config.plugins = config.plugins || {};
config.plugins.entries = config.plugins.entries || {};
config.plugins.entries[pluginId] = {
  ...(config.plugins.entries[pluginId] || {}),
  hooks: {
    ...(config.plugins.entries[pluginId]?.hooks || {}),
    allowConversationAccess: true,
  },
};
config.channels = {
  ...(config.channels || {}),
  "kitchen-sink-channel": { enabled: true, token: "kitchen-sink-ci" },
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

remove_kitchen_sink_channel_config() {
  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete config.channels?.["kitchen-sink-channel"];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
NODE
}

assert_kitchen_sink_installed() {
  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.env.KITCHEN_SINK_ID;
const spec = process.env.KITCHEN_SINK_SPEC;
const source = process.env.KITCHEN_SINK_SOURCE;
const surfaceMode = process.env.KITCHEN_SINK_SURFACE_MODE;
const label = process.env.KITCHEN_SINK_LABEL;
const list = JSON.parse(fs.readFileSync(`/tmp/kitchen-sink-${label}-plugins.json`, "utf8"));
const inspect = JSON.parse(fs.readFileSync(`/tmp/kitchen-sink-${label}-inspect.json`, "utf8"));
const allInspect = JSON.parse(fs.readFileSync(`/tmp/kitchen-sink-${label}-inspect-all.json`, "utf8"));
const plugin = (list.plugins || []).find((entry) => entry.id === pluginId);
if (!plugin) throw new Error(`kitchen-sink plugin not found after install: ${pluginId}`);
if (plugin.status !== "loaded") {
  throw new Error(`unexpected kitchen-sink status after enable: ${plugin.status}`);
}
if (inspect.plugin?.id !== pluginId) {
  throw new Error(`unexpected inspected kitchen-sink plugin id: ${inspect.plugin?.id}`);
}
if (inspect.plugin?.enabled !== true || inspect.plugin?.status !== "loaded") {
  throw new Error(
    `expected enabled loaded kitchen-sink plugin, got enabled=${inspect.plugin?.enabled} status=${inspect.plugin?.status}`,
  );
}

const expectIncludes = (listValue, expected, field) => {
  if (!Array.isArray(listValue) || !listValue.includes(expected)) {
    throw new Error(`${field} missing ${expected}: ${JSON.stringify(listValue)}`);
  }
};
expectIncludes(inspect.plugin?.channelIds, "kitchen-sink-channel", "channels");
expectIncludes(inspect.plugin?.providerIds, "kitchen-sink-provider", "providers");

const diagnostics = [
  ...(list.diagnostics || []),
  ...(inspect.diagnostics || []),
  ...(allInspect.diagnostics || []),
];
const errorMessages = new Set(
  diagnostics
    .filter((diag) => diag?.level === "error")
    .map((diag) => String(diag.message || "")),
);

if (surfaceMode === "full") {
  const toolNames = Array.isArray(inspect.tools)
    ? inspect.tools.flatMap((entry) => (Array.isArray(entry?.names) ? entry.names : []))
    : [];
  expectIncludes(inspect.plugin?.speechProviderIds, "kitchen-sink-speech-provider", "speech providers");
  expectIncludes(
    inspect.plugin?.realtimeTranscriptionProviderIds,
    "kitchen-sink-realtime-transcription-provider",
    "realtime transcription providers",
  );
  expectIncludes(
    inspect.plugin?.realtimeVoiceProviderIds,
    "kitchen-sink-realtime-voice-provider",
    "realtime voice providers",
  );
  expectIncludes(
    inspect.plugin?.mediaUnderstandingProviderIds,
    "kitchen-sink-media-understanding-provider",
    "media understanding providers",
  );
  expectIncludes(
    inspect.plugin?.imageGenerationProviderIds,
    "kitchen-sink-image-generation-provider",
    "image generation providers",
  );
  expectIncludes(
    inspect.plugin?.videoGenerationProviderIds,
    "kitchen-sink-video-generation-provider",
    "video generation providers",
  );
  expectIncludes(
    inspect.plugin?.musicGenerationProviderIds,
    "kitchen-sink-music-generation-provider",
    "music generation providers",
  );
  expectIncludes(inspect.plugin?.webFetchProviderIds, "kitchen-sink-web-fetch-provider", "web fetch providers");
  expectIncludes(inspect.plugin?.webSearchProviderIds, "kitchen-sink-web-search-provider", "web search providers");
  expectIncludes(inspect.plugin?.migrationProviderIds, "kitchen-sink-migration-provider", "migration providers");
  expectIncludes(inspect.plugin?.agentHarnessIds, "kitchen-sink-agent-harness", "agent harnesses");
  expectIncludes(inspect.services, "kitchen-sink-service", "services");
  expectIncludes(inspect.commands, "kitchen-sink-command", "commands");
  expectIncludes(toolNames, "kitchen-sink-tool", "tools");
  if ((inspect.plugin?.hookCount || 0) < 30 || !Array.isArray(inspect.typedHooks) || inspect.typedHooks.length < 30) {
    throw new Error(
      `expected kitchen-sink typed hooks to load, got hookCount=${inspect.plugin?.hookCount} typedHooks=${inspect.typedHooks?.length}`,
    );
  }

  const expectedErrorMessages = new Set([
    "only bundled plugins can register agent tool result middleware",
    "cli registration missing explicit commands metadata",
    "only bundled plugins can register Codex app-server extension factories",
    "http route registration missing or invalid auth: /kitchen-sink/http-route",
    "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: kitchen-sink-memory-embedding-provider",
  ]);
  for (const message of errorMessages) {
    if (!expectedErrorMessages.has(message)) {
      throw new Error(`unexpected kitchen-sink diagnostic error: ${message}`);
    }
  }
  for (const message of expectedErrorMessages) {
    if (!errorMessages.has(message)) {
      throw new Error(`missing expected kitchen-sink diagnostic error: ${message}`);
    }
  }
} else if (errorMessages.size > 0) {
  throw new Error(`unexpected kitchen-sink diagnostic errors: ${[...errorMessages].join(", ")}`);
}

const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const record = (index.installRecords ?? index.records ?? {})[pluginId];
if (!record) throw new Error(`missing kitchen-sink install record for ${pluginId}`);
if (record.source !== source) {
  throw new Error(`expected kitchen-sink install source=${source}, got ${record.source}`);
}
if (source === "npm") {
  const expectedSpec = spec.replace(/^npm:/u, "");
  if (record.spec !== expectedSpec) {
    throw new Error(`expected kitchen-sink npm spec ${expectedSpec}, got ${record.spec}`);
  }
  if (!record.resolvedVersion || !record.resolvedSpec) {
    throw new Error(`missing npm resolution metadata: ${JSON.stringify(record)}`);
  }
} else if (source === "clawhub") {
  const value = spec.slice("clawhub:".length).trim();
  const slashIndex = value.lastIndexOf("/");
  const atIndex = value.lastIndexOf("@");
  const packageName = atIndex > 0 && atIndex > slashIndex ? value.slice(0, atIndex) : value;
  if (record.spec !== spec) {
    throw new Error(`expected kitchen-sink ClawHub spec ${spec}, got ${record.spec}`);
  }
  if (record.clawhubPackage !== packageName) {
    throw new Error(`expected ClawHub package ${packageName}, got ${record.clawhubPackage}`);
  }
  if (record.clawhubFamily !== "code-plugin" && record.clawhubFamily !== "bundle-plugin") {
    throw new Error(`unexpected ClawHub family: ${record.clawhubFamily}`);
  }
  if (!record.version || !record.integrity || !record.resolvedAt) {
    throw new Error(`missing ClawHub resolution metadata: ${JSON.stringify(record)}`);
  }
}
if (typeof record.installPath !== "string" || record.installPath.length === 0) {
  throw new Error("missing kitchen-sink install path");
}
const installPath = record.installPath.replace(/^~(?=$|\/)/u, process.env.HOME);
if (!fs.existsSync(installPath)) {
  throw new Error(`kitchen-sink install path missing: ${record.installPath}`);
}
fs.writeFileSync(`/tmp/kitchen-sink-${label}-install-path.txt`, installPath, "utf8");
console.log("ok");
NODE
}

assert_kitchen_sink_removed() {
  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.env.KITCHEN_SINK_ID;
const label = process.env.KITCHEN_SINK_LABEL;
const list = JSON.parse(fs.readFileSync(`/tmp/kitchen-sink-${label}-uninstalled.json`, "utf8"));
if ((list.plugins || []).some((entry) => entry.id === pluginId)) {
  throw new Error(`kitchen-sink plugin still listed after uninstall: ${pluginId}`);
}

const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {};
const records = index.installRecords ?? index.records ?? {};
if (records[pluginId]) {
  throw new Error(`kitchen-sink install record still present after uninstall: ${pluginId}`);
}

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
if (config.plugins?.entries?.[pluginId]) {
  throw new Error(`kitchen-sink config entry still present after uninstall: ${pluginId}`);
}
if ((config.plugins?.allow || []).includes(pluginId)) {
  throw new Error(`kitchen-sink allowlist still contains ${pluginId}`);
}
if ((config.plugins?.deny || []).includes(pluginId)) {
  throw new Error(`kitchen-sink denylist still contains ${pluginId}`);
}
if (config.channels?.["kitchen-sink-channel"]) {
  throw new Error("kitchen-sink channel config still present after uninstall");
}
const installPathFile = `/tmp/kitchen-sink-${label}-install-path.txt`;
if (fs.existsSync(installPathFile)) {
  const installPath = fs.readFileSync(installPathFile, "utf8").trim();
  if (installPath && fs.existsSync(installPath)) {
    throw new Error(`kitchen-sink managed install directory still exists: ${installPath}`);
  }
}
console.log("ok");
NODE
}

run_success_scenario() {
  echo "Testing ${KITCHEN_SINK_LABEL} install from ${KITCHEN_SINK_SPEC}..."
  run_logged_print "kitchen-sink-install-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins install "$KITCHEN_SINK_SPEC"
  run_logged_print "kitchen-sink-enable-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins enable "$KITCHEN_SINK_ID"
  configure_kitchen_sink_runtime
  node "$OPENCLAW_ENTRY" plugins list --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-plugins.json"
  node "$OPENCLAW_ENTRY" plugins inspect "$KITCHEN_SINK_ID" --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-inspect.json"
  node "$OPENCLAW_ENTRY" plugins inspect --all --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-inspect-all.json"
  assert_kitchen_sink_installed
  if [ "$KITCHEN_SINK_SOURCE" = "clawhub" ]; then
    run_logged_print "kitchen-sink-uninstall-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins uninstall "$KITCHEN_SINK_SPEC" --force
  else
    run_logged_print "kitchen-sink-uninstall-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins uninstall "$KITCHEN_SINK_ID" --force
  fi
  remove_kitchen_sink_channel_config
  node "$OPENCLAW_ENTRY" plugins list --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-uninstalled.json"
  assert_kitchen_sink_removed
}

run_failure_scenario() {
  echo "Testing expected ${KITCHEN_SINK_LABEL} install failure from ${KITCHEN_SINK_SPEC}..."
  run_expect_failure "install-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins install "$KITCHEN_SINK_SPEC"
  remove_kitchen_sink_channel_config
  node "$OPENCLAW_ENTRY" plugins list --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-uninstalled.json"
  assert_kitchen_sink_removed
}

if [[ "$KITCHEN_SINK_SCENARIOS" == *"clawhub:"* ]] &&
  [[ "${OPENCLAW_KITCHEN_SINK_LIVE_CLAWHUB:-0}" != "1" ]] &&
  [[ -z "${OPENCLAW_CLAWHUB_URL:-}" && -z "${CLAWHUB_URL:-}" ]]; then
  clawhub_fixture_dir="$(mktemp -d "/tmp/openclaw-kitchen-sink-clawhub.XXXXXX")"
  start_kitchen_sink_clawhub_fixture_server "$clawhub_fixture_dir"
fi

scenario_count=0
while IFS='|' read -r label spec plugin_id source expectation surface_mode; do
  if [ -z "${label:-}" ] || [[ "$label" == \#* ]]; then
    continue
  fi
  scenario_count=$((scenario_count + 1))
  export KITCHEN_SINK_LABEL="$label"
  export KITCHEN_SINK_SPEC="$spec"
  export KITCHEN_SINK_ID="$plugin_id"
  export KITCHEN_SINK_SOURCE="$source"
  export KITCHEN_SINK_SURFACE_MODE="$surface_mode"
  case "$expectation" in
  success)
    run_success_scenario
    ;;
  failure)
    run_failure_scenario
    ;;
  *)
    echo "Unknown kitchen-sink expectation for ${label}: ${expectation}" >&2
    exit 1
    ;;
  esac
done <<<"$KITCHEN_SINK_SCENARIOS"

if [ "$scenario_count" -eq 0 ]; then
  echo "No kitchen-sink plugin scenarios configured." >&2
  exit 1
fi

scan_logs_for_unexpected_errors
echo "kitchen-sink plugin Docker E2E passed (${scenario_count} scenario(s))"
