run_plugins_clawhub_scenario() {
  if [ "${OPENCLAW_PLUGINS_E2E_CLAWHUB:-1}" = "0" ]; then
    echo "Skipping ClawHub plugin install and uninstall (OPENCLAW_PLUGINS_E2E_CLAWHUB=0)."
  else
    echo "Testing ClawHub kitchen-sink plugin install and uninstall..."
    CLAWHUB_PLUGIN_SPEC="${OPENCLAW_PLUGINS_E2E_CLAWHUB_SPEC:-clawhub:openclaw-kitchen-sink}"
    CLAWHUB_PLUGIN_ID="${OPENCLAW_PLUGINS_E2E_CLAWHUB_ID:-openclaw-kitchen-sink-fixture}"
    export CLAWHUB_PLUGIN_SPEC CLAWHUB_PLUGIN_ID

    start_clawhub_fixture_server() {
      local fixture_dir="$1"
      local server_log="$fixture_dir/clawhub-fixture.log"
      local server_port_file="$fixture_dir/clawhub-fixture-port"
      local server_pid_file="$fixture_dir/clawhub-fixture-pid"

      node scripts/e2e/lib/plugins/clawhub-fixture-server.cjs "$server_port_file" >"$server_log" 2>&1 &
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
      echo "Timed out waiting for ClawHub fixture server." >&2
      return 1
    }

    if [[ -z "${OPENCLAW_CLAWHUB_URL:-}" && -z "${CLAWHUB_URL:-}" ]]; then
      # Keep the release-path smoke hermetic; live ClawHub can rate-limit CI.
      clawhub_fixture_dir="$(mktemp -d "/tmp/openclaw-clawhub-fixture.XXXXXX")"
      start_clawhub_fixture_server "$clawhub_fixture_dir"
    fi

    node - <<'NODE'
const spec = process.env.CLAWHUB_PLUGIN_SPEC;
if (!spec?.startsWith("clawhub:")) {
  throw new Error(`expected clawhub: spec, got ${spec}`);
}

const parsePackageName = (rawSpec) => {
  const value = rawSpec.slice("clawhub:".length).trim();
  const slashIndex = value.lastIndexOf("/");
  const atIndex = value.lastIndexOf("@");
  return atIndex > 0 && atIndex > slashIndex ? value.slice(0, atIndex) : value;
};

const packageName = parsePackageName(spec);
const baseUrl = (process.env.OPENCLAW_CLAWHUB_URL || process.env.CLAWHUB_URL || "https://clawhub.ai")
  .replace(/\/+$/, "");
const token =
  process.env.OPENCLAW_CLAWHUB_TOKEN ||
  process.env.CLAWHUB_TOKEN ||
  process.env.CLAWHUB_AUTH_TOKEN ||
  "";
const response = await fetch(`${baseUrl}/api/v1/packages/${encodeURIComponent(packageName)}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : undefined,
});
if (!response.ok) {
  const body = await response.text().catch(() => "");
  throw new Error(`ClawHub package preflight failed for ${packageName}: ${response.status} ${body}`);
}
const detail = await response.json();
const family = detail.package?.family;
if (family !== "code-plugin" && family !== "bundle-plugin") {
  throw new Error(`ClawHub package ${packageName} is not installable as a plugin: ${family}`);
}
if (detail.package?.runtimeId && detail.package.runtimeId !== process.env.CLAWHUB_PLUGIN_ID) {
  throw new Error(
    `ClawHub package ${packageName} runtimeId ${detail.package.runtimeId} does not match expected ${process.env.CLAWHUB_PLUGIN_ID}`,
  );
}
console.log(`Using ClawHub package ${packageName} (${family}).`);
NODE

    run_logged install-clawhub node "$OPENCLAW_ENTRY" plugins install "$CLAWHUB_PLUGIN_SPEC"
    node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-clawhub-installed.json
    node "$OPENCLAW_ENTRY" plugins inspect "$CLAWHUB_PLUGIN_ID" --json >/tmp/plugins-clawhub-inspect.json

    node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.env.CLAWHUB_PLUGIN_ID;
const spec = process.env.CLAWHUB_PLUGIN_SPEC;
const parsePackageName = (rawSpec) => {
  const value = rawSpec.slice("clawhub:".length).trim();
  const slashIndex = value.lastIndexOf("/");
  const atIndex = value.lastIndexOf("@");
  return atIndex > 0 && atIndex > slashIndex ? value.slice(0, atIndex) : value;
};
const packageName = parsePackageName(spec);
const list = JSON.parse(fs.readFileSync("/tmp/plugins-clawhub-installed.json", "utf8"));
const inspect = JSON.parse(fs.readFileSync("/tmp/plugins-clawhub-inspect.json", "utf8"));
const plugin = (list.plugins || []).find((entry) => entry.id === pluginId);
if (!plugin) throw new Error(`ClawHub plugin not found after install: ${pluginId}`);
if (plugin.status !== "loaded") {
  throw new Error(`unexpected ClawHub plugin status for ${pluginId}: ${plugin.status}`);
}
if (inspect.plugin?.id !== pluginId) {
  throw new Error(`unexpected ClawHub inspect plugin id: ${inspect.plugin?.id}`);
}

const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const allowLegacyCompat = process.env.OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT === "1";
if (!allowLegacyCompat && !index.installRecords) {
  throw new Error("expected modern installRecords in installed plugin index");
}
const installRecords = allowLegacyCompat
  ? index.installRecords ?? index.records ?? config.plugins?.installs ?? {}
  : index.installRecords ?? {};
const record = installRecords[pluginId];
if (!record) throw new Error(`missing ClawHub install record for ${pluginId}`);
if (record.source !== "clawhub") {
  throw new Error(`unexpected ClawHub install source for ${pluginId}: ${record.source}`);
}
if (record.clawhubPackage !== packageName) {
  throw new Error(
    `unexpected ClawHub package for ${pluginId}: ${record.clawhubPackage}, expected ${packageName}`,
  );
}
if (record.clawhubFamily !== "code-plugin" && record.clawhubFamily !== "bundle-plugin") {
  throw new Error(`unexpected ClawHub family for ${pluginId}: ${record.clawhubFamily}`);
}
if (typeof record.installPath !== "string" || record.installPath.length === 0) {
  throw new Error(`missing ClawHub install path for ${pluginId}`);
}

const installPath = record.installPath.replace(/^~(?=$|\/)/, process.env.HOME);
const extensionsRoot = path.join(process.env.HOME, ".openclaw", "extensions");
if (!installPath.startsWith(`${extensionsRoot}${path.sep}`)) {
  throw new Error(`ClawHub install path is outside managed extensions root: ${installPath}`);
}
if (!fs.existsSync(installPath)) {
  throw new Error(`ClawHub install path missing on disk: ${installPath}`);
}
fs.writeFileSync("/tmp/plugins-clawhub-install-path.txt", installPath, "utf8");
console.log("ok");
NODE

    run_logged uninstall-clawhub node "$OPENCLAW_ENTRY" plugins uninstall "$CLAWHUB_PLUGIN_SPEC" --force
    node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-clawhub-uninstalled.json

    node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.env.CLAWHUB_PLUGIN_ID;
const installPath = fs.readFileSync("/tmp/plugins-clawhub-install-path.txt", "utf8").trim();
const list = JSON.parse(fs.readFileSync("/tmp/plugins-clawhub-uninstalled.json", "utf8"));
if ((list.plugins || []).some((entry) => entry.id === pluginId)) {
  throw new Error(`ClawHub plugin still listed after uninstall: ${pluginId}`);
}

const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {};
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const installRecords = index.installRecords ?? index.records ?? config.plugins?.installs ?? {};
if (installRecords[pluginId]) {
  throw new Error(`ClawHub install record still present after uninstall: ${pluginId}`);
}

const configAfterUninstallPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const configAfterUninstall = fs.existsSync(configAfterUninstallPath)
  ? JSON.parse(fs.readFileSync(configAfterUninstallPath, "utf8"))
  : {};
if (configAfterUninstall.plugins?.entries?.[pluginId]) {
  throw new Error(`ClawHub config entry still present after uninstall: ${pluginId}`);
}
if ((configAfterUninstall.plugins?.allow || []).includes(pluginId)) {
  throw new Error(`ClawHub allowlist entry still present after uninstall: ${pluginId}`);
}
if ((configAfterUninstall.plugins?.deny || []).includes(pluginId)) {
  throw new Error(`ClawHub denylist entry still present after uninstall: ${pluginId}`);
}
if (fs.existsSync(installPath)) {
  throw new Error(`ClawHub managed install directory still exists after uninstall: ${installPath}`);
}
console.log("ok");
NODE
  fi
}
