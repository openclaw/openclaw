#!/usr/bin/env bash

set -euo pipefail

CONFIG_FILE="${MOUNT_SHARES_CONFIG:-$HOME/.config/mount-shares.env}"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [mount|status|print-config|help]

默认行为：一键挂载 ~/raid 和 ~/huawei。
适合在局域网里的其他 Mac 上直接执行。

可选配置文件：$CONFIG_FILE
推荐配置方式（适合其他 Mac 自动挂载）：
  RAID_HOST='raid.local'
  RAID_SHARE='raid'
  RAID_USER='your-user'
  RAID_PASSWORD='your-password'

  HUAWEI_HOST='huawei.my'
  HUAWEI_SHARE='家庭共享'
  HUAWEI_USER='GUEST'
  HUAWEI_PASSWORD=''

也支持直接指定完整 source：
  RAID_SOURCE='//user:password@raid.local/raid'
  HUAWEI_SOURCE='//GUEST@huawei.my/%E5%AE%B6%E5%BA%AD%E5%85%B1%E4%BA%AB'

说明：
  - 未设置 PASSWORD 时，macOS 可能会弹出密码提示，不算“全自动”
  - 如需完全无提示挂载，请在配置文件里设置 PASSWORD，或改用 ~/.nsmbrc
  - SHARE 支持直接写中文；脚本会优先尝试自动编码
EOF
}

print_config() {
  cat <<EOF
# 保存到: $CONFIG_FILE
# chmod 600 $CONFIG_FILE

RAID_TARGET='$HOME/raid'
HUAWEI_TARGET='$HOME/huawei'

# 方式 1：按 host/share/user/password 拆开写，适合其他 Mac 复用
RAID_HOST='raid.local'
RAID_SHARE='raid'
RAID_USER='your-user'
RAID_PASSWORD='your-password'

HUAWEI_HOST='huawei.my'
HUAWEI_SHARE='家庭共享'
HUAWEI_USER='GUEST'
HUAWEI_PASSWORD=''

# 方式 2：直接写完整 source；若设置了 SOURCE，会覆盖上面的 HOST/SHARE/USER/PASSWORD
# RAID_SOURCE='//user:password@raid.local/raid'
# HUAWEI_SOURCE='//GUEST@huawei.my/%E5%AE%B6%E5%BA%AD%E5%85%B1%E4%BA%AB'
EOF
}

require_macos() {
  command -v mount_smbfs >/dev/null 2>&1 || {
    printf 'ERROR: 这个脚本依赖 macOS 的 mount_smbfs。\n' >&2
    exit 1
  }
}

normalize_host() {
  local host="$1"
  host="${host#smb://}"
  host="${host#//}"
  host="${host%/}"
  printf '%s' "$host"
}

encode_share() {
  local share="$1"

  if [[ -z "$share" ]]; then
    return 0
  fi

  share="${share#/}"

  if [[ "$share" == *%* ]]; then
    printf '%s' "$share"
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$share" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=""), end="")
PY
    return 0
  fi

  printf '%s' "$share"
}

build_source() {
  local source="$1"
  local user="$2"
  local password="$3"
  local host="$4"
  local share="$5"

  if [[ -n "$source" ]]; then
    printf '%s' "$source"
    return 0
  fi

  host="$(normalize_host "$host")"
  share="$(encode_share "$share")"

  if [[ -z "$host" || -z "$share" ]]; then
    return 0
  fi

  if [[ -n "$user" && -n "$password" ]]; then
    printf '//%s:%s@%s/%s' "$user" "$password" "$host" "$share"
    return 0
  fi

  if [[ -n "$user" ]]; then
    printf '//%s@%s/%s' "$user" "$host" "$share"
    return 0
  fi

  printf '//%s/%s' "$host" "$share"
}

redact_source() {
  printf '%s' "$1" | sed -E 's#//([^/@:]+):[^@]*@#//\1:***@#'
}

is_mounted() {
  mount | grep -F " on $1 (" >/dev/null 2>&1
}

warn_if_nonempty_dir() {
  local target="$1"
  if [[ -d "$target" ]] && find "$target" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    warn "$target 不是空目录；挂载后会临时遮住下面原有内容，卸载后会恢复。"
  fi
}

mount_one() {
  local label="$1"
  local help_name="$2"
  local source="$3"
  local target="$4"

  if [[ -z "$source" ]]; then
    warn "$label 未配置。请运行: $(basename "$0") print-config"
    warn "然后在 $CONFIG_FILE 里填写 ${help_name}_HOST / ${help_name}_SHARE / ${help_name}_USER / ${help_name}_PASSWORD"
    return 1
  fi

  mkdir -p "$target"

  if is_mounted "$target"; then
    log "$label: 已挂载 -> $target"
    return 0
  fi

  warn_if_nonempty_dir "$target"
  log "$label: 挂载 $(redact_source "$source") -> $target"
  mount_smbfs "$source" "$target"
  log "$label: 完成"
}

show_status() {
  local target
  for target in "$RAID_TARGET" "$HUAWEI_TARGET"; do
    if is_mounted "$target"; then
      df -h "$target"
    else
      log "未挂载: $target"
    fi
    printf '\n'
  done
}

RAID_TARGET="${RAID_TARGET:-$HOME/raid}"
HUAWEI_TARGET="${HUAWEI_TARGET:-$HOME/huawei}"

RAID_HOST="${RAID_HOST:-}"
RAID_SHARE="${RAID_SHARE:-}"
RAID_USER="${RAID_USER:-}"
RAID_PASSWORD="${RAID_PASSWORD:-}"
RAID_SOURCE="${RAID_SOURCE:-}"

HUAWEI_HOST="${HUAWEI_HOST:-huawei.my}"
HUAWEI_SHARE="${HUAWEI_SHARE:-家庭共享}"
HUAWEI_USER="${HUAWEI_USER:-GUEST}"
HUAWEI_PASSWORD="${HUAWEI_PASSWORD:-}"
HUAWEI_SOURCE="${HUAWEI_SOURCE:-}"

RAID_SOURCE="$(build_source "$RAID_SOURCE" "$RAID_USER" "$RAID_PASSWORD" "$RAID_HOST" "$RAID_SHARE")"
HUAWEI_SOURCE="$(build_source "$HUAWEI_SOURCE" "$HUAWEI_USER" "$HUAWEI_PASSWORD" "$HUAWEI_HOST" "$HUAWEI_SHARE")"

main() {
  local action="${1:-mount}"
  require_macos

  case "$action" in
    mount)
      local failures=0
      mount_one "raid" "RAID" "$RAID_SOURCE" "$RAID_TARGET" || failures=1
      mount_one "huawei" "HUAWEI" "$HUAWEI_SOURCE" "$HUAWEI_TARGET" || failures=1
      printf '\n'
      show_status
      exit "$failures"
      ;;
    status)
      show_status
      ;;
    print-config)
      print_config
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
