import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (name) => readFileSync(new URL(`../src-tauri/src/${name}.rs`, import.meta.url), "utf8");
const main = source("main");
const gateway = source("gateway");

function method(text, name) {
  const declaration = new RegExp(
    `^( +)(?:pub(?:\\([^)]*\\))? )?(?:async )?fn ${name}\\b[^]*?^\\1}$`,
    "m",
  );
  const match = text.match(declaration);
  assert.ok(match, `missing production method ${name}`);
  return match[0];
}

function withoutOtherPlatformReadiness(text) {
  return text.replace(
    /#\[cfg\(not\(any\(target_os = "linux", target_os = "windows"\)\)\)\]\s*let \w+ = gateway::ensure_ready\([^;]+;/g,
    "",
  );
}

// This is an architecture guard for the actual desktop entry paths. The Rust
// CLI-recorder test proves status behavior; it cannot catch startup calling a
// different (mutating) helper before or after that observation.
const serviceMutation =
  /runtime_migration|runtime_action::(?:fresh|activate)|gateway::(?:ensure_ready|act|run_service_command)|\.(?:connect_explicit_local|install_cli|runtime_action|submit_runtime|submit_action)\s*\(|GatewayOperation::(?:Install|Runtime|Action)\b|["']gateway["']\s*,\s*["'](?:install|start|stop|restart)["']/;

test("Linux and Windows startup and reconnect paths never invoke Gateway service mutations", () => {
  for (const name of [
    "connect",
    "connect_selected",
    "resolve_cli",
    "finish_local_connection",
    "watch_local",
    "restore_healthy_local_dashboard",
  ]) {
    assert.doesNotMatch(withoutOtherPlatformReadiness(method(main, name)), serviceMutation, name);
  }
  assert.match(method(main, "connect"), /\.connect_selected\(/);
  assert.match(method(main, "connect_selected"), /gateway::status\(&cli\)/);
  assert.match(gateway, /#\[cfg\(not\(any\(target_os = "linux", target_os = "windows"\)\)\)\]\s*pub fn ensure_ready\b/);
});

test("explicit Linux and Windows first-run setup installs only when no service is installed or reachable", () => {
  const explicit = method(main, "connect_explicit_local");
  assert.match(explicit, /#\[cfg\(any\(target_os = "linux", target_os = "windows"\)\)\]\s*if let Ok\(cli\) = self\.resolve_cli\(\)/);
  assert.match(explicit, /let snapshot = gateway::status\(&cli\)\?/);
  const absent = explicit.match(
    /if !snapshot\.installed && !snapshot\.reachable \{[^]*?^ {12}\}/m,
  );
  assert.ok(absent, "explicit setup must establish service absence before installing");
  assert.match(absent[0], /return self\.install_cli\(app, InstallChannel::Stable, selection\)/);
  assert.doesNotMatch(explicit.replace(absent[0], ""), /\.install_cli\(/);
});

test("app updates cannot install, restore, or switch the Gateway service", () => {
  const updater = source("updater").split("#[cfg(test)]")[0];
  assert.doesNotMatch(updater, serviceMutation);
  assert.doesNotMatch(updater, /OpenClawCli|run_service_command|runtime_action|bundled_runtime/);
});

test("bundled-runtime mutations belong only to the two explicit user actions", () => {
  const setup = method(main, "install_cli");
  const action = method(main, "runtime_action");
  assert.match(setup, /runtime_action::fresh\(/);
  assert.match(action, /runtime_action::activate\(/);
  assert.doesNotMatch(
    main.replace(setup, "").replace(action, ""),
    /runtime_action::(?:fresh|activate)\(/,
  );
});

test("bundled runtime supports Linux and Windows while confirmation stays Linux-only", () => {
  for (const module of ["bundled_runtime", "runtime_action"]) {
    assert.match(main, new RegExp(`#\\[cfg\\(any\\(target_os = "linux", target_os = "windows", test\\)\\)\\]\\s*mod ${module};`));
  }
  assert.match(
    source("tray"),
    /#\[cfg\(target_os = "linux"\)\]\s*fn confirm_runtime_action\b/,
  );
});
