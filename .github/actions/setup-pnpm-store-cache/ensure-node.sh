#!/usr/bin/env bash

openclaw_node_version_matches() {
  local actual="$1"
  local requested="$2"
  if [[ -z "$requested" ]]; then
    return 0
  fi
  case "$requested" in
    *x)
      [[ "${actual%%.*}" == "${requested%%.*}" ]]
      ;;
    *.*.*)
      [[ "$actual" == "$requested" ]]
      ;;
    *.*)
      [[ "$actual" == "$requested".* ]]
      ;;
    *)
      [[ "${actual%%.*}" == "$requested" ]]
      ;;
  esac
}

openclaw_active_node_version() {
  node -p 'process.versions.node' 2>/dev/null || true
}

openclaw_prepend_node_bin() {
  local node_bin_dir="$1"
  export PATH="$node_bin_dir:$PATH"
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "$node_bin_dir" >> "$GITHUB_PATH"
  fi
  hash -r
}

openclaw_find_toolcache_node() {
  local requested_node="$1"
  local roots=()
  local root
  for root in \
    "${RUNNER_TOOL_CACHE:-}" \
    "${AGENT_TOOLSDIRECTORY:-}" \
    "${ACTIONS_RUNNER_TOOL_CACHE:-}" \
    "${OPENCLAW_CONTAINER_TOOL_CACHE:-/__t}" \
    "/opt/hostedtoolcache" \
    "/home/runner/_work/_tool" \
    "/Users/runner/hostedtoolcache" \
    "/c/hostedtoolcache/windows"
  do
    if [[ -d "$root/node" ]]; then
      roots+=("$root/node")
    elif [[ "$(basename "$root")" == "node" && -d "$root" ]]; then
      roots+=("$root")
    fi
  done

  local node_root candidate candidate_version
  for node_root in "${roots[@]}"; do
    while IFS= read -r candidate; do
      candidate_version="$("$candidate" -p 'process.versions.node' 2>/dev/null || true)"
      if openclaw_node_version_matches "$candidate_version" "$requested_node"; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(find "$node_root" \( -name node -o -name node.exe \) -type f 2>/dev/null | sort -r)
  done
  return 1
}

openclaw_resolve_node_download_version() {
  local requested_node="$1"
  if [[ "$requested_node" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    [[ "$requested_node" == v* ]] && printf '%s\n' "$requested_node" || printf 'v%s\n' "$requested_node"
    return 0
  fi

  local prefix="${requested_node#v}"
  prefix="${prefix%%[xX]*}"
  prefix="v${prefix}"
  [[ "$prefix" == *. ]] || prefix="${prefix}."
  curl -fsSL https://nodejs.org/dist/index.json |
    OPENCLAW_NODE_PREFIX="$prefix" node -e '
const fs = require("node:fs");
const prefix = process.env.OPENCLAW_NODE_PREFIX;
const versions = JSON.parse(fs.readFileSync(0, "utf8"));
const match = versions.find((item) => String(item.version || "").startsWith(prefix));
if (match) {
  process.stdout.write(match.version + "\n");
}
'
}

openclaw_node_download_platform() {
  local os_name arch_name
  os_name="$(uname -s)"
  arch_name="$(uname -m)"
  case "$os_name:$arch_name" in
    Linux:x86_64) printf 'linux-x64\n' ;;
    Linux:aarch64 | Linux:arm64) printf 'linux-arm64\n' ;;
    Darwin:x86_64) printf 'darwin-x64\n' ;;
    Darwin:arm64) printf 'darwin-arm64\n' ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64) printf 'win-x64\n' ;;
    MINGW*:aarch64 | MINGW*:arm64 | MSYS*:aarch64 | MSYS*:arm64 | CYGWIN*:aarch64 | CYGWIN*:arm64) printf 'win-arm64\n' ;;
    *)
      return 1
      ;;
  esac
}

openclaw_windows_path() {
  cygpath -w "$1" 2>/dev/null || printf '%s\n' "$1"
}

openclaw_download_node() {
  local requested_node="$1"
  local version platform archive_url install_root
  version="$(openclaw_resolve_node_download_version "$requested_node")"
  platform="$(openclaw_node_download_platform)" || return 1
  install_root="${RUNNER_TEMP:-/tmp}/openclaw-node-${version}-${platform}"
  mkdir -p "$install_root"
  if [[ "$platform" == win-* ]]; then
    local archive_path extracted_dir
    archive_url="https://nodejs.org/dist/${version}/node-${version}-${platform}.zip"
    archive_path="$install_root/node.zip"
    extracted_dir="$install_root/node-${version}-${platform}"
    echo "Downloading Node ${version} from ${archive_url}"
    curl -fsSL "$archive_url" -o "$archive_path"
    pwsh -NoProfile -Command "Expand-Archive -LiteralPath '$(openclaw_windows_path "$archive_path")' -DestinationPath '$(openclaw_windows_path "$install_root")' -Force"
    if [[ -d "$extracted_dir" ]]; then
      openclaw_prepend_node_bin "$extracted_dir"
    else
      openclaw_prepend_node_bin "$install_root"
    fi
  else
    archive_url="https://nodejs.org/dist/${version}/node-${version}-${platform}.tar.xz"
    echo "Downloading Node ${version} from ${archive_url}"
    curl -fsSL "$archive_url" | tar -xJ -C "$install_root" --strip-components=1
    openclaw_prepend_node_bin "$install_root/bin"
  fi
}

openclaw_ensure_node() {
  local requested_node="${1:-}"
  requested_node="${requested_node#v}"
  if [[ -z "$requested_node" ]]; then
    return 0
  fi

  local active_node_version node_bin
  active_node_version="$(openclaw_active_node_version)"
  if openclaw_node_version_matches "$active_node_version" "$requested_node"; then
    echo "Using active Node ${active_node_version} at $(command -v node)"
    return 0
  fi

  node_bin="$(openclaw_find_toolcache_node "$requested_node" || true)"
  if [[ -n "$node_bin" ]]; then
    echo "Using Node $("$node_bin" -p 'process.versions.node') from $node_bin"
    openclaw_prepend_node_bin "$(dirname "$node_bin")"
  else
    openclaw_download_node "$requested_node" || true
  fi

  active_node_version="$(openclaw_active_node_version)"
  if ! openclaw_node_version_matches "$active_node_version" "$requested_node"; then
    echo "::error::Expected Node '${requested_node}', but active node is '${active_node_version:-missing}' at $(command -v node || true)"
    return 1
  fi
}
