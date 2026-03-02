#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
case "$cmd" in
  supplier|permissions|sql)
    ;;
  *)
    echo "Only 'supplier', 'sql' and 'permissions' commands are allowed." >&2
    exit 1
    ;;
esac

set +e
output="$(/Users/haruki/.nvm/versions/node/v24.13.0/bin/node /Users/haruki/openclaw/skills/erp-query/scripts/secure-query.cjs --wecom-user-id WangChong "$@" 2>&1)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  printf '%s\n' "$output"
  exit 0
fi

if printf '%s' "$output" | grep -Eiq "(当前没有权限。|has no ACL entry\.|has no roles\.|is not allowed for this user\.|does not have procurement voucher permissions\.|must include explicit voucher_type/ref_voucher_type filters\.)"; then
  echo "当前没有权限。"
  exit 1
fi

printf '%s\n' "$output" >&2
exit "$status"
