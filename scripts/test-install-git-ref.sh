#!/bin/bash
set -euo pipefail

# Run each installer in a fresh environment, without the developer's Git/npm config.
if [[ "${1:-}" != --case ]]; then
  root="$(cd "$(dirname "$0")/.." && pwd)"
  default_installer="$root/scripts/install-cli.sh"
  [[ ! -f "$root/public/install-cli.sh" ]] || default_installer="$root/public/install-cli.sh"
  for installer in "${@:-$default_installer}"; do
    for scenario in transient ssh exhausted authentication ssh-auth missing lightweight annotated full retained retained-annotated; do
      fixture="$(mktemp -d)"
      mkdir -p "$fixture/home"
      result=0
      env -i PATH="$PATH" HOME="$fixture/home" TMPDIR="$fixture" \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
        /bin/bash "$0" --case "$installer" "$scenario" >"$fixture/result.log" 2>&1 || result=$?
      cat "$fixture/result.log"
      rm -rf "$fixture"
      [[ "$result" == 0 ]] || exit "$result"
    done
  done
  exit 0
fi

installer="$2"
scenario="$3"
export OPENCLAW_INSTALL_CLI_SH_NO_RUN=1 OPENCLAW_INSTALL_SH_NO_RUN=1
# shellcheck source=/dev/null
source "$installer"
run_quiet_step() { shift; "$@"; }
git() {
  if [[ " $* " == *' ls-remote '* ]]; then
    local count
    count="$(cat "$work/probes")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$work/probes"
    if [[ "$scenario" == exhausted || ( ( "$scenario" == transient || "$scenario" == ssh ) && "$count" -lt 3 ) ]]; then
      if [[ "$scenario" == ssh ]]; then
        if [[ "$count" == 1 ]]; then
          printf '%s\n' 'kex_exchange_identification: Connection closed by remote host' >&2
        else
          printf '%s\n' 'Connection to example.invalid closed by remote host.' >&2
        fi
      elif [[ "$scenario" == transient ]]; then
        if [[ "$count" == 1 ]]; then
          printf '%s\n' 'fatal: unable to access https://user:synthetic-password@example.invalid/repo?token=synthetic-query: Empty reply from server' >&2
        else
          printf '%s\n' 'fatal: HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR' >&2
        fi
      else
        if [[ "$count" == 2 ]]; then
          printf '%s\n' 'fatal: gnutls_handshake() failed: Error in the pull function.' >&2
        else
          printf '%s\n' 'fatal: unable to access https://user:synthetic-password@example.invalid/repo?token=synthetic-query: Could not resolve host: example.invalid' >&2
        fi
      fi
      return 128
    elif [[ "$scenario" == authentication || "$scenario" == ssh-auth ]]; then
      if [[ "$scenario" == ssh-auth ]]; then
        printf '%s\n' 'user@example.invalid: Permission denied (publickey).' 'Connection closed by remote host' >&2
      else
        printf '%s\n' 'fatal: Authentication failed for https://user:synthetic-password@example.invalid/repo' 'aUtHoRiZaTiOn: Bearer synthetic-header' 'COOKIE: synthetic-cookie' >&2
      fi
      return 128
    fi
  fi
  command git "$@"
}
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
seed="$work/seed"
repo="$work/repo"
ref=v2026.10.5
command git init -q --initial-branch=main "$seed"
command git -C "$seed" config user.email test@example.invalid
command git -C "$seed" config user.name test
printf 'base\n' > "$seed/state.txt"
command git -C "$seed" add state.txt
command git -C "$seed" commit -qm base
printf 'release\n' > "$seed/state.txt"
command git -C "$seed" add state.txt
command git -C "$seed" commit -qm release
expected="$(command git -C "$seed" rev-parse HEAD)"
if [[ "$scenario" == annotated || "$scenario" == retained-annotated ]]; then
  command git -C "$seed" tag -am release "$ref"
else
  command git -C "$seed" tag "$ref"
fi
printf 'main\n' > "$seed/state.txt"
command git -C "$seed" commit -qam main
if [[ "$scenario" == full ]]; then
  command git clone -q --no-tags "file://$seed" "$repo"
elif [[ "$scenario" == retained* ]]; then
  command git clone -q --depth 3 --no-tags "file://$seed" "$repo"
else
  command git clone -q --depth 1 --no-tags "file://$seed" "$repo"
fi
printf '0\n' > "$work/probes"

# Keep retry tests fast without replacing any Git behavior.
sleep() { :; }
export GIT_UPDATE=0
requested="$ref"
[[ "$scenario" != missing ]] || requested=v404
result=0
(set -e; checkout_git_openclaw_ref "$repo" "$requested") > "$work/output" 2>&1 || result=$?
cat "$work/output"
if grep -Eq 'synthetic-password|synthetic-query|synthetic-header|synthetic-cookie' "$work/output"; then
  echo 'FAIL: credentials leaked in Git diagnostics' >&2
  exit 1
fi
case "$scenario" in
  transient|ssh|lightweight|annotated|full|retained|retained-annotated)
    [[ "$result" == 0 ]] || exit 1
    [[ "$(command git -C "$repo" rev-parse HEAD)" == "$expected" ]] || exit 1
    [[ -z "$(command git -C "$repo" symbolic-ref --quiet HEAD || true)" ]] || exit 1
    if [[ "$scenario" == full || "$scenario" == retained* ]]; then
      [[ "$(command git -C "$repo" rev-list --count HEAD)" == 2 ]] || exit 1
    else
      [[ "$(command git -C "$repo" rev-list --count HEAD)" == 1 ]] || exit 1
    fi
    [[ "$scenario" != retained* || "$(command git -C "$repo" rev-list --count main)" == 3 ]] || exit 1
    ;;
  exhausted|authentication|ssh-auth)
    [[ "$result" != 0 ]] || exit 1
    grep -Eq 'fatal:|Permission denied' "$work/output" || exit 1
    ;;
  missing)
    [[ "$result" != 0 ]] || exit 1
    grep -q 'Requested git version not found: v404' "$work/output" || exit 1
    ;;
esac || exit 1
case "$scenario" in
  transient|ssh|exhausted) [[ "$(cat "$work/probes")" == 3 ]] ;;
  authentication|ssh-auth|lightweight|annotated|full|retained|retained-annotated) [[ "$(cat "$work/probes")" == 1 ]] ;;
  missing) [[ "$(cat "$work/probes")" == 2 ]] ;;
esac || exit 1
printf 'PASS: %s %s\n' "$(basename "$installer")" "$scenario"
