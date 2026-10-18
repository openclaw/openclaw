#!/usr/bin/env bash

extract_openclaw_semver() {
  local raw="${1:-}"
  raw="${raw//$'\r'/}"
  if [[ "$raw" =~ v?([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z.-]+)?) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

print_npm_config_without_freshness() {
  local source_path
  local -a source_paths=()
  for source_path in "$@"; do
    [[ -f "$source_path" ]] && source_paths+=("$source_path")
  done
  ((${#source_paths[@]} > 0)) || return 0
  awk '
    tolower($0) !~ /^[[:space:]]*(before|min-release-age)[[:space:]]*=/
  ' "${source_paths[@]}"
}

print_npm_config_for_release() {
  print_npm_config_without_freshness "$@" |
    awk 'tolower($0) !~ /^[[:space:]]*(globalconfig|userconfig)[[:space:]]*=/'
}

run_npm_without_freshness_policy() {
  local env_name normalized
  local -a unset_args=()
  while IFS= read -r env_name; do
    normalized="$(printf '%s' "$env_name" | tr '[:upper:]' '[:lower:]')"
    case "$normalized" in
      npm_config_before | npm_config_min_release_age | npm_config_min-release-age | npm_config_userconfig | npm_config_globalconfig)
        unset_args+=(-u "$env_name")
        ;;
    esac
  done < <(
    node -e 'for (const name of Object.keys(process.env)) process.stdout.write(`${name}\n`);'
  )
  if ((${#unset_args[@]} > 0)); then
    env "${unset_args[@]}" "$@"
  else
    env "$@"
  fi
}

read_npm_config_env() {
  NPM_CONFIG_ENV_KEY="$1" node - <<'NODE'
const expected = `npm_config_${process.env.NPM_CONFIG_ENV_KEY}`;
// npm lifecycle scripts inject lowercase config names; those override inherited copies.
let selected = process.env[expected] || "";
if (!selected) {
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toLowerCase() === expected && value) selected = value;
  }
}
process.stdout.write(selected);
NODE
}

resolve_npm_config_path_value() {
  NPM_CONFIG_PATH_VALUE="$1" NPM_CONFIG_PATH_PARSE_INI="${2:-false}" node - <<'NODE'
const path = require("node:path");
const os = require("node:os");
let value = process.env.NPM_CONFIG_PATH_VALUE || "";
if (process.env.NPM_CONFIG_PATH_PARSE_INI === "true" && !((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
  let escaped = false;
  let parsed = "";
  for (const character of value.trim()) {
    if (escaped) {
      parsed += "\\;#".includes(character) ? character : `\\${character}`;
      escaped = false;
    } else if (character === ";" || character === "#") {
      break;
    } else if (character === "\\") {
      escaped = true;
    } else {
      parsed += character;
    }
  }
  value = `${parsed}${escaped ? "\\" : ""}`.trim();
}
if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
  value = value.slice(1, -1);
}
value = value.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (original, escapes, name, optional) => {
  const replacement = process.env[name] ?? (optional ? "" : `\${${name}}`);
  return escapes.length % 2 ? original.slice((escapes.length + 1) / 2) : `${escapes.slice(escapes.length / 2)}${replacement}`;
});
if (value.startsWith("~/")) {
  value = path.join(process.env.HOME || os.homedir(), value.slice(2));
}
process.stdout.write(path.resolve(value));
NODE
}

find_npm_project_root() {
  node - "$PWD" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const start = path.resolve(process.argv[2]);
let current = start;
let localPrefix;
while (true) {
  const packagePath = path.join(current, "package.json");
  const hasPackage = fs.existsSync(packagePath);
  if (!localPrefix && (hasPackage || fs.existsSync(path.join(current, "node_modules")))) {
    localPrefix = current;
  } else if (localPrefix && hasPackage) {
    try {
      const workspaces = JSON.parse(fs.readFileSync(packagePath, "utf8")).workspaces;
      const patterns = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
      const relative = path.relative(current, localPrefix);
      const positivePatterns = [];
      const negativePatterns = [];
      for (const raw of Array.isArray(patterns) ? patterns : []) {
        if (typeof raw !== "string") continue;
        const exclusion = raw.match(/^!+/)?.[0] ?? "";
        const pattern = raw.slice(exclusion.length).replace(/^\.?\/+/, "").replace(/\/+$/, "");
        if (exclusion.length % 2 === 1) {
          negativePatterns.push(pattern);
          continue;
        }
        for (let index = negativePatterns.length - 1; index >= 0; index -= 1) {
          if (path.matchesGlob(pattern, negativePatterns[index])) negativePatterns.splice(index, 1);
        }
        positivePatterns.push(pattern);
      }
      const included = positivePatterns.some((pattern) => path.matchesGlob(relative, pattern)) &&
        !negativePatterns.some((pattern) => path.matchesGlob(relative, pattern));
      if (included) {
        process.stdout.write(current);
        process.exit(0);
      }
    } catch {}
  }
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
process.stdout.write(localPrefix ?? start);
NODE
}

read_npm_config_path() {
  local config_path="$1"
  local key="$2"
  local raw
  [[ -f "$config_path" ]] || return 0
  raw="$(
    awk -F= -v key="$key" '
      tolower($1) ~ "^[[:space:]]*" key "[[:space:]]*$" {
        value = substr($0, index($0, "=") + 1)
      }
      END {
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        print value
      }
    ' "$config_path"
  )"
  [[ -n "$raw" ]] || return 0
  resolve_npm_config_path_value "$raw" true
}

quiet_npm() {
  local arg global_config_path previous_arg project_config_path project_root project_sandbox status user_config_path
  local global_mode=false
  previous_arg=""
  for arg in "$@"; do
    case "$arg" in
      -g | --global | --location=global) global_mode=true ;;
    esac
    if [[ "$previous_arg" == "--location" && "$arg" == "global" ]]; then
      global_mode=true
    fi
    previous_arg="$arg"
  done
  # npm cannot report its local prefix when caller config combines the two
  # freshness policies. The release harness needs the nearest package root only.
  project_config_path=""
  if [[ "$global_mode" != "true" ]]; then
    project_root="$(find_npm_project_root)"
    project_config_path="$project_root/.npmrc"
  fi
  user_config_path="$(read_npm_config_env userconfig)" || return
  if [[ -n "$user_config_path" ]]; then
    user_config_path="$(resolve_npm_config_path_value "$user_config_path")" || return
  fi
  if [[ -z "$user_config_path" && "$global_mode" != "true" ]]; then
    user_config_path="$(read_npm_config_path "$project_config_path" userconfig)" || return
  fi
  if [[ -z "$user_config_path" ]]; then
    user_config_path="$(resolve_npm_config_path_value "~/.npmrc")" || return
  fi
  global_config_path="$(read_npm_config_env globalconfig)" || return
  if [[ -n "$global_config_path" ]]; then
    global_config_path="$(resolve_npm_config_path_value "$global_config_path")" || return
  fi
  if [[ -z "$global_config_path" && "$global_mode" != "true" ]]; then
    global_config_path="$(read_npm_config_path "$project_config_path" globalconfig)" || return
  fi
  if [[ -z "$global_config_path" ]]; then
    global_config_path="$(read_npm_config_path "$user_config_path" globalconfig)" || return
  fi
  if [[ -z "$global_config_path" ]]; then
    global_config_path="$(
      run_npm_without_freshness_policy npm \
        --location=global \
        --userconfig=<(print_npm_config_without_freshness "$user_config_path") \
        config get globalconfig
    )" || return
  fi

  if [[ "$global_mode" == "true" ]]; then
    run_npm_without_freshness_policy \
      npm \
      --location=global \
      --userconfig=<(print_npm_config_for_release "$user_config_path") \
      --globalconfig=<(print_npm_config_for_release "$global_config_path") \
      --loglevel=error \
      --logs-max=0 \
      --no-update-notifier \
      --no-fund \
      --no-audit \
      --no-progress \
      "$@"
    return
  fi

  project_sandbox="$(mktemp -d)" || return
  printf '{"private":true}\n' >"$project_sandbox/package.json" || {
    rm -rf -- "$project_sandbox"
    return 1
  }
  print_npm_config_for_release "$project_config_path" >"$project_sandbox/.npmrc" || {
    rm -rf -- "$project_sandbox"
    return 1
  }
  run_npm_without_freshness_policy \
    npm \
    --prefix="$project_sandbox" \
    --userconfig=<(print_npm_config_for_release "$user_config_path") \
    --globalconfig=<(print_npm_config_for_release "$global_config_path") \
    --loglevel=error \
    --logs-max=0 \
    --no-update-notifier \
    --no-fund \
    --no-audit \
    --no-progress \
    "$@"
  status=$?
  rm -rf -- "$project_sandbox"
  return "$status"
}

resolve_previous_npm_version() {
  local package_name="$1"
  local target_version="$2"
  local versions_json
  versions_json="$(quiet_npm view "$package_name" versions --json)" || return
  # npm sorts versions by SemVer. Anchor to the selected target so newer
  # publications cannot silently turn upgrade coverage into a downgrade.
  VERSIONS_JSON="$versions_json" node - "$package_name" "$target_version" <<'NODE'
const [packageName, target] = process.argv.slice(2);
const versions = JSON.parse(process.env.VERSIONS_JSON || "[]");
const index = Array.isArray(versions) ? versions.lastIndexOf(target) : -1;
if (index <= 0) {
  console.error(`No published predecessor for ${packageName}@${target}. Set an explicit previous version or skip preinstallation for a fresh-install test.`);
  process.exit(2);
}
process.stdout.write(versions[index - 1]);
NODE
}
