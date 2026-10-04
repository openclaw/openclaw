#!/bin/bash
# Shared by both installer profiles; only function definitions belong here.

node_binary_has_safe_sqlite() {
    local node_bin="$1"
    "$node_bin" -e '
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(":memory:");
        try {
            const value = db.prepare("SELECT sqlite_version() AS version").get()?.version;
            const match = typeof value === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value) : null;
            const major = Number(match?.[1]);
            const minor = Number(match?.[2]);
            const patch = Number(match?.[3]);
            const safe =
                major > 3 ||
                (major === 3 &&
                    (minor > 51 ||
                        (minor === 51 && patch >= 3) ||
                        (minor === 50 && patch >= 7) ||
                        (minor === 44 && patch >= 6)));
            const text = "a\u0000b\u0000";
            const bytes = Buffer.from(text, "utf8");
            const json = JSON.stringify({ value: text });
            db.exec("CREATE TABLE probe (text_value TEXT, blob_value BLOB, json_value TEXT)");
            db.prepare("INSERT INTO probe VALUES (?, ?, ?)").run(text, bytes, json);
            const row = db.prepare("SELECT text_value, blob_value, json_value FROM probe").get();
            const textSafe = typeof row?.text_value === "string" && row.text_value.length === text.length && Buffer.from(row.text_value, "utf8").equals(bytes);
            const blobSafe = row?.blob_value instanceof Uint8Array && Buffer.from(row.blob_value).equals(bytes);
            const jsonSafe = row?.json_value === json && JSON.parse(row.json_value).value === text;
            if (!textSafe) {
                console.error("Node " + process.versions.node + ": node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.16+/26.1+ or a build with the fix");
            } else if (!blobSafe || !jsonSafe) {
                console.error("Node " + process.versions.node + ": node:sqlite NUL round-trip capability probe failed; use 24.16+/26.1+ or a build with the fix");
            } else if (!safe) {
                console.error("Node " + process.versions.node + ": SQLite " + value + " is not WAL-reset-safe");
            }
            if (!safe || !textSafe || !blobSafe || !jsonSafe) process.exitCode = 1;
        } finally {
            db.close();
        }
    ' --no-warnings >/dev/null
}

node_binary_sqlite_version() {
    local node_bin="$1"
    local version
    version="$("$node_bin" -e '
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(":memory:");
        try {
            process.stdout.write(String(db.prepare("SELECT sqlite_version() AS version").get()?.version ?? "unknown"));
        } finally {
            db.close();
        }
    ' 2>/dev/null || true)"
    printf '%s\n' "${version:-unavailable}"
}

resolve_npm_config_path() {
    local raw="$1"
    if [[ -z "$raw" || "$raw" == "null" || "$raw" == "undefined" ]]; then
        return 1
    fi
    if [[ "$raw" == \~/* && -n "${HOME:-}" ]]; then
        printf '%s\n' "${HOME}/${raw#"~/"}"
        return 0
    fi
    if [[ "$raw" == "\${HOME}/"* && -n "${HOME:-}" ]]; then
        printf '%s\n' "${HOME}/${raw#"\${HOME}/"}"
        return 0
    fi
    printf '%s\n' "$raw"
}

npm_config_file_has_key() {
    local file="$1"
    local key="$2"
    [[ -f "$file" ]] || return 1
    grep -Eiq "^[[:space:]]*${key}[[:space:]]*=" "$file"
}

npm_command_path() {
    local npm_cmd="$1"
    local npm_path="$npm_cmd"
    if [[ "$npm_path" != */* ]]; then
        npm_path="$(command -v "$npm_cmd" 2>/dev/null)" || return 1
    fi
    if command -v node >/dev/null 2>&1; then
        node -e 'const fs = require("node:fs"); console.log(fs.realpathSync(process.argv[1]));' "$npm_path" 2>/dev/null && return 0
    fi
    printf '%s\n' "$npm_path"
}

npm_builtin_config_path() {
    local npm_cmd="$1"
    local npm_path
    npm_path="$(npm_command_path "$npm_cmd")" || return 1
    local npm_root
    npm_root="$(cd "$(dirname "$npm_path")/.." >/dev/null 2>&1 && pwd -P)" || return 1
    printf '%s\n' "${npm_root}/npmrc"
}

npm_config_has_raw_key() {
    local npm_cmd="$1"
    local key="$2"
    local project_dir="${3:-}"
    local raw=""
    local file=""
    local -a files=()

    if [[ -n "$project_dir" ]]; then
        files+=("${project_dir}/.npmrc")
    fi

    raw="${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-}}"
    if [[ -n "$raw" ]]; then
        file="$(resolve_npm_config_path "$raw" 2>/dev/null || true)"
        [[ -n "$file" ]] && files+=("$file")
    elif [[ -n "${HOME:-}" ]]; then
        files+=("${HOME}/.npmrc")
    fi

    raw="${NPM_CONFIG_GLOBALCONFIG:-${npm_config_globalconfig:-}}"
    if [[ -n "$raw" ]]; then
        file="$(resolve_npm_config_path "$raw" 2>/dev/null || true)"
        [[ -n "$file" ]] && files+=("$file")
    fi

    raw="$(env -u NPM_CONFIG_BEFORE -u npm_config_before -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$npm_cmd" config get globalconfig --global 2>/dev/null || true)"
    file="$(resolve_npm_config_path "$raw" 2>/dev/null || true)"
    [[ -n "$file" ]] && files+=("$file")

    file="$(npm_builtin_config_path "$npm_cmd" 2>/dev/null || true)"
    [[ -n "$file" ]] && files+=("$file")

    for file in "${files[@]}"; do
        if npm_config_file_has_key "$file" "$key"; then
            return 0
        fi
    done
    return 1
}

npm_lifecycle_allow_arg() {
    local npm_cmd="$1" spec="$2" npm_cwd="${3:-$PWD}" exact_identity="${4:-}" version="" output=""
    if ! version="$("$npm_cmd" --version 2>/dev/null)"; then
        installer_npm_version_error "$npm_cmd"
        return 1
    fi
    output="$(installer_node - "$version" "$spec" "$npm_cwd" "$exact_identity" <<'NODE'
const path = require("node:path");
const [versionOutput, spec, cwd, exactIdentity] = process.argv.slice(2);
const version = versionOutput.trim().split(/\r?\n/).at(-1) ?? "";
const parsed = version.match(/^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };
if (!parsed) fail("Unable to determine npm version; no package changes were made.");
if (+parsed[1] < 12 && (+parsed[1] !== 11 || +parsed[2] < 16)) process.exit(0);
const normalized = spec.trim();
const unaliased = normalized.toLowerCase().startsWith("openclaw@") ? normalized.slice(9).trim() : normalized;
const explicit = (value) => /\.(?:tgz|tar\.gz)$/i.test(value) || value.includes("://") || value.includes("#") || /^(?:file|github|git\+(?:ssh|https|http|file)|npm):/i.test(value);
let identity = !normalized || explicit(normalized) || explicit(unaliased) || /^\.{1,2}(?:[\\/]|$)/.test(unaliased) || path.isAbsolute(normalized) || path.isAbsolute(unaliased) ? unaliased : "openclaw";
const alias = /^npm:/i.test(identity);
if (alias) identity = /^npm:(@[^/]+\/[^@]+|[^@]+?)(?:@.*)?$/i.exec(identity)?.[1] ?? "";
const filePrefix = /^file:/i.test(identity) ? "file:" : "";
const archivePath = identity.slice(filePrefix.length);
const gitShorthand = !/^~[\\/]/.test(identity) && /^[^./@\s:#][^/\s:@#]*\/[^/\s:@#]+(?:#[\s\S]*)?$/.test(identity);
const localArchive = !alias && !gitShorthand && /\.(?:tgz|tar\.gz|tar)$/i.test(archivePath) && (filePrefix || path.isAbsolute(archivePath) || !/^[a-z][a-z0-9+.-]*:/i.test(archivePath));
let absoluteArchive = "";
if (localArchive) {
  const npmPath = process.platform === "win32" ? archivePath.replaceAll("\\", "/") : archivePath;
  // Escape raw paths before URL normalization so literal %, #, and ? retain their identity.
  let fileUrl = `file:${encodeURI(npmPath).replace(/[?#]/g, encodeURIComponent)}`;
  fileUrl = fileUrl.replace(/^file:\/\/(?=[^/])/, "file:/").replace(/^file:\/{1,3}(?=\.\.?(?:\/|$))/, "file:");
  const specPath = decodeURIComponent(new URL(fileUrl).pathname);
  let resolvedPath = decodeURIComponent(new URL(fileUrl, `${require("node:url").pathToFileURL(path.resolve(cwd || process.cwd())).href}/`).pathname);
  if (process.platform === "win32") resolvedPath = resolvedPath.replace(/^\/+([a-z]:\/)/i, "$1");
  absoluteArchive = /^\/~(?:\/|$)/.test(specPath) ? path.resolve(require("node:os").homedir(), specPath.slice(3)) : path.resolve(cwd || process.cwd(), resolvedPath);
}
// Tarballs match the absolute npm resolved identity; directory links accept relative paths.
// Keep the npm 11 comma-path identity: its advisory/strict decision stays npm-owned.
if (absoluteArchive && (+parsed[1] >= 12 || !absoluteArchive.includes(","))) identity = `${filePrefix}${absoluteArchive}`;
else {
  const relative = cwd && path.isAbsolute(identity) ? path.relative(cwd, identity) || "." : "";
  if (relative) identity = path.isAbsolute(relative) || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) ? relative : `.${path.sep}${relative}`;
}
if (exactIdentity) identity = exactIdentity;
if (!identity || identity.includes(",")) fail(`npm cannot allow lifecycle scripts for install target '${spec}'; use a package URL or local path without commas.`);
process.stdout.write(`--allow-scripts=${identity}\n`);
NODE
)" || return 1
    printf '%s' "$output"
}

set_pnpm_cmd() {
    PNPM_CMD=("$@")
}

run_pnpm() (
    local repo_dir="$PWD"
    if [[ "${1:-}" == "-C" ]]; then
        repo_dir="$2"
        shift 2
    fi
    cd "$repo_dir" || return 1
    # Pin nested commands and inherited roots only for this child. Corepack's
    # cold-cache prompt would otherwise wait invisibly in the version probe.
    env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH="${PNPM_CMD[0]%/*}:$PATH" \
      NPM_CONFIG_WORKSPACE_DIR="$PWD" npm_config_workspace_dir="$PWD" \
      PNPM_CONFIG_LOCKFILE_DIR="$PWD" pnpm_config_lockfile_dir="$PWD" \
      "${PNPM_CMD[@]}" "$@"
)

should_prefer_offline_pnpm_install() {
    local project_dir="${1:-$PWD}"
    [[ -z "${PNPM_CONFIG_PREFER_OFFLINE+x}" && -z "${pnpm_config_prefer_offline+x}" ]] || return 1
    local configured=""
    configured="$(run_pnpm -C "$project_dir" config get prefer-offline 2>/dev/null)" || return 1
    [[ -z "$configured" || "$configured" == "undefined" || "$configured" == "null" ]]
}

resolve_git_openclaw_ref() {
    local requested="${OPENCLAW_VERSION:-latest}"
    local resolved_version=""

    case "$requested" in
        ""|latest|next|beta)
            resolved_version="$(installer_npm view "openclaw" "dist-tags.${requested:-latest}" 2>/dev/null || true)"
            if [[ -n "$resolved_version" ]]; then
                echo "v${resolved_version}"
            elif [[ -z "$requested" || "$requested" == "latest" ]]; then
                echo "main"
            else
                echo "$requested"
            fi
            return 0
            ;;
        [0-9]*.[0-9]*.[0-9]*)
            echo "v${requested}"
            return 0
            ;;
        *)
            echo "$requested"
            return 0
            ;;
    esac
}

verify_git_rebase_recovery() {
    local repo_dir="$1"
    local expected_head="$2"
    local expected_status="$3"
    local git_dir

    git_dir="$(git -C "$repo_dir" rev-parse --absolute-git-dir)" || return 1
    if [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
        git -C "$repo_dir" rebase --abort >/dev/null 2>&1 || return 1
    fi

    [[ "$(git -C "$repo_dir" rev-parse --verify HEAD 2>/dev/null)" == "$expected_head" ]] &&
        [[ "$(git -C "$repo_dir" status --porcelain=v1 --untracked-files=all 2>/dev/null)" == "$expected_status" ]] &&
        [[ ! -d "$git_dir/rebase-merge" && ! -d "$git_dir/rebase-apply" ]]
}

git_install_lockfile_flag() {
    if [[ "$1" == "moving" ]]; then
        echo "--no-frozen-lockfile"
    else
        echo "--frozen-lockfile"
    fi
}

clone_git_checkout_transactionally() {
    local repo_url="$1"
    local repo_dir="$2"
    shift 2

    local parent_dir staging_dir clone_status=0 preserve_repo_dir=0
    parent_dir="$(dirname "$repo_dir")"
    mkdir -p "$parent_dir"
    parent_dir="$(cd "$parent_dir" && pwd -P)"
    if [[ -d "$repo_dir" && -z "$(ls -A "$repo_dir" 2>/dev/null || true)" ]]; then
        preserve_repo_dir=1
        repo_dir="$(cd "$repo_dir" && pwd -P)"
        staging_dir="$(mktemp -d "${repo_dir}/.openclaw-clone.XXXXXX")"
    else
        repo_dir="${parent_dir}/$(basename "$repo_dir")"
        staging_dir="$(mktemp -d "${parent_dir}/.openclaw-clone.XXXXXX")"
    fi
    TMPFILES+=("$staging_dir")

    installer_step "Cloning OpenClaw" git clone "$@" "$repo_url" "$staging_dir" || clone_status=$?
    if (( clone_status != 0 )); then
        return "$clone_status"
    fi

    if ! node - "$staging_dir" "$repo_dir" "$preserve_repo_dir" <<'NODE'
const fs = require("node:fs");
const [source, target, preserveTarget] = process.argv.slice(2);
if (preserveTarget === "0") {
  try {
    fs.lstatSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.renameSync(source, target);
    process.exit(0);
  }
  throw new Error(`Git install dir appeared while cloning: ${target}`);
}
const expected = preserveTarget === "1" ? [source.slice(source.lastIndexOf("/") + 1)] : [];
if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).sort().join("\0") !== expected.sort().join("\0")) {
  throw new Error(`Git install dir appeared while cloning: ${target}`);
}
const entries = fs.readdirSync(source).sort((a, b) => (a === ".git" ? 1 : b === ".git" ? -1 : 0));
const moved = [];
try {
  for (const entry of entries) {
    fs.renameSync(`${source}/${entry}`, `${target}/${entry}`);
    moved.push(entry);
  }
  fs.rmdirSync(source);
} catch (error) {
  const rollbackErrors = [];
  for (const entry of moved.reverse()) {
    try {
      fs.renameSync(`${target}/${entry}`, `${source}/${entry}`);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
  if (rollbackErrors.length > 0) {
    let recovery = source;
    try {
      recovery = `${source}.recovery`;
      fs.renameSync(source, recovery);
    } catch (recoveryError) {
      rollbackErrors.push(recoveryError);
      recovery = source;
    }
    throw new AggregateError(
      [error, ...rollbackErrors],
      `Could not publish or fully roll back the cloned checkout at ${target}; recovery files remain at ${recovery}`,
    );
  }
  throw error;
}
NODE
    then
        installer_clone_error "$repo_dir"
    fi
}

repo_pnpm_spec() {
    local repo_dir="$1"
    local package_json="${repo_dir}/package.json"

    if [[ ! -f "$package_json" ]]; then
        return 1
    fi

    installer_node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (typeof pkg.packageManager === "string") process.stdout.write(pkg.packageManager);' "$package_json"
}

to_lowercase_ascii() {
    # macOS still ships Bash 3.2, so avoid `${value,,}` here.
    printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

is_openclaw_source_package_install_spec() {
    local value="${1:-}"
    local normalized_value=""
    normalized_value="$(to_lowercase_ascii "$value")"
    normalized_value="${normalized_value#openclaw@}"

    [[ "$normalized_value" == "main" ]] && return 0
    [[ "$normalized_value" =~ ^github:openclaw/openclaw($|[#/]) ]] && return 0

    normalized_value="${normalized_value#git+}"
    [[ "$normalized_value" =~ ^https?://github\.com/openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
    [[ "$normalized_value" =~ ^ssh://git@github\.com[:/]openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
    [[ "$normalized_value" =~ ^git://github\.com/openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
    [[ "$normalized_value" =~ ^git@github\.com:openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
    return 1
}

is_root() {
    [[ "$(id -u)" -eq 0 ]]
}
