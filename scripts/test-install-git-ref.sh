#!/bin/bash
set -euo pipefail

# Run each installer in a fresh environment, without the developer's Git/npm config.
if [[ "${1:-}" != --case ]]; then
  root="$(cd "$(dirname "$0")/.." && pwd)"
  for installer in "${@:-$root/scripts/install-cli.sh}"; do
    for scenario in transient exhausted authentication missing lightweight annotated; do
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
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
seed="$work/seed"
repo="$work/repo"
ref=v2026.10.5
git init -q --initial-branch=main "$seed"
git -C "$seed" config user.email test@example.invalid
git -C "$seed" config user.name test
printf 'release\n' > "$seed/state.txt"
git -C "$seed" add state.txt
git -C "$seed" commit -qm release
expected="$(git -C "$seed" rev-parse HEAD)"
if [[ "$scenario" == annotated ]]; then
  git -C "$seed" tag -am release "$ref"
else
  git -C "$seed" tag "$ref"
fi
printf 'main\n' > "$seed/state.txt"
git -C "$seed" commit -qam main
git clone -q --depth 1 --no-tags "file://$seed" "$repo"
printf '0\n' > "$work/probes"

git() {
  if [[ " $* " == *' ls-remote '* ]]; then
    local count
    count="$(cat "$work/probes")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$work/probes"
    if [[ "$scenario" == exhausted || ( "$scenario" == transient && "$count" -lt 3 ) ]]; then
      printf '%s\n' 'fatal: unable to access https://user:synthetic-password@example.invalid/repo?token=synthetic-query: Could not resolve host: example.invalid' >&2
      return 128
    elif [[ "$scenario" == authentication ]]; then
      printf '%s\n' 'fatal: Authentication failed for https://user:synthetic-password@example.invalid/repo' 'Authorization: Bearer synthetic-header' >&2
      return 128
    fi
  fi
  command git "$@"
}
# Keep retry tests fast without replacing any Git behavior.
sleep() { :; }
export GIT_UPDATE=0
requested="$ref"
[[ "$scenario" != missing ]] || requested=v404
result=0
(set -e; checkout_git_openclaw_ref "$repo" "$requested") > "$work/output" 2>&1 || result=$?
cat "$work/output"
if grep -Eq 'synthetic-password|synthetic-query|synthetic-header' "$work/output"; then
  echo 'FAIL: credentials leaked in Git diagnostics' >&2
  exit 1
fi
case "$scenario" in
  transient|lightweight|annotated)
    [[ "$result" == 0 ]] || exit 1
    [[ "$(command git -C "$repo" rev-parse HEAD)" == "$expected" ]] || exit 1
    [[ -z "$(command git -C "$repo" symbolic-ref --quiet HEAD || true)" ]] || exit 1
    ;;
  exhausted|authentication)
    [[ "$result" != 0 ]] || exit 1
    grep -q 'fatal:' "$work/output" || exit 1
    ;;
  missing)
    [[ "$result" != 0 ]] || exit 1
    grep -q 'Requested git version not found: v404' "$work/output" || exit 1
    ;;
esac || exit 1
case "$scenario" in
  transient|exhausted) [[ "$(cat "$work/probes")" == 3 ]] ;;
  authentication|lightweight|annotated) [[ "$(cat "$work/probes")" == 1 ]] ;;
  missing) [[ "$(cat "$work/probes")" == 2 ]] ;;
esac || exit 1
printf 'PASS: %s %s\n' "$(basename "$installer")" "$scenario"
