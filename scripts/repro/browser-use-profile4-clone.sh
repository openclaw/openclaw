#!/usr/bin/env bash
set -euo pipefail

# Browser Use is a separate browser stack from OpenClaw, so we keep its setup
# explicit and reproducible instead of trusting global PATH state. This helper:
# 1) creates a repo-local Python 3.12 venv
# 2) installs Browser Use into that venv
# 3) optionally clones the user's real Chrome profile for future experiments
# 4) runs the current CLI-supported benchmark path against Browser Use's local
#    real-browser mode using an OpenAI key
#
# Important limitation:
# The currently installed Browser Use CLI (0.12.x) does not expose a
# --user-data-dir flag for local real-browser runs. In practice, it launches
# Chrome with its own temp user-data-dir and then uses the provided
# --profile-directory name inside that temp browser root. So this helper's
# clone step is only for future Python-level experiments; the CLI run path
# does not currently consume the cloned profile data directly.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="${BROWSER_USE_VENV_DIR:-$ROOT_DIR/.venv-browser-use}"
PYTHON_VERSION="${BROWSER_USE_PYTHON_VERSION:-3.12}"
SOURCE_CHROME_DIR="${OPENCLAW_SOURCE_CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}"
SOURCE_PROFILE_NAME="${OPENCLAW_SOURCE_PROFILE_NAME:-Profile 4}"
CLONE_CHROME_DIR="${BROWSER_USE_CLONE_CHROME_DIR:-/tmp/browser-use-profile4-clone}"
BROWSER_USE_SESSION_NAME="${BROWSER_USE_SESSION_NAME:-bu-emirates-$(date +%Y%m%d-%H%M%S)}"

usage() {
  cat <<'EOF'
Usage:
  scripts/repro/browser-use-profile4-clone.sh setup
  scripts/repro/browser-use-profile4-clone.sh doctor
  scripts/repro/browser-use-profile4-clone.sh prepare-profile
  scripts/repro/browser-use-profile4-clone.sh run-emirates

Commands:
  setup
    Create/update a repo-local Browser Use venv pinned to Python 3.12 and
    install Browser Use into it.

  doctor
    Run Browser Use's own diagnostics so we can distinguish local install
    problems from missing API-key access.

  prepare-profile
    Clone the user's real Chrome profile into a throwaway user-data-dir for
    future Browser Use experiments. The current CLI benchmark path does not
    consume this clone directly because Browser Use local real-browser mode
    uses its own temp user-data-dir.

  run-emirates
    Run the March 22 Emirates benchmark in Browser Use real-browser mode.
    Uses a unique Browser Use session name by default so stale default-session
    state does not poison reruns. Requires OPENAI_API_KEY to be set in the
    environment.
EOF
}

ensure_setup() {
  cd "$ROOT_DIR"

  # We pin Browser Use to a repo-local venv so benchmark results do not depend
  # on whichever global CLI version happens to be installed on this machine.
  uv venv "$VENV_DIR" --python "$PYTHON_VERSION"
  uv pip install --python "$VENV_DIR/bin/python" --upgrade browser-use
}

prepare_profile() {
  cd "$ROOT_DIR"

  # Keep this clone path around because it is still useful for future direct
  # Browser Use Python experiments, even though the current CLI benchmark path
  # does not read from it.
  rm -rf "$CLONE_CHROME_DIR"
  mkdir -p "$CLONE_CHROME_DIR"
  cp "${SOURCE_CHROME_DIR}/Local State" "${CLONE_CHROME_DIR}/Local State"
  rsync -a --delete \
    "${SOURCE_CHROME_DIR}/${SOURCE_PROFILE_NAME}/" \
    "${CLONE_CHROME_DIR}/${SOURCE_PROFILE_NAME}/"

  echo "Prepared Browser Use clone profile:"
  echo "  source: ${SOURCE_PROFILE_NAME}"
  echo "  clone:  ${CLONE_CHROME_DIR}"
}

doctor() {
  cd "$ROOT_DIR"

  if [ ! -x "$VENV_DIR/bin/browser-use" ]; then
    echo "Browser Use venv is missing. Run 'setup' first." >&2
    exit 1
  fi

  # Browser Use has a built-in doctor command, so use the source of truth
  # instead of inventing our own checklist every time this lane gets revisited.
  "$VENV_DIR/bin/browser-use" doctor
}

run_emirates() {
  cd "$ROOT_DIR"

  if [ ! -x "$VENV_DIR/bin/browser-use" ]; then
    echo "Browser Use venv is missing. Run 'setup' first." >&2
    exit 1
  fi

  if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY is missing. Export it first." >&2
    exit 1
  fi

  # Use a unique session name by default. Browser Use's CLI reuses named local
  # sessions aggressively, and stale session reuse was one source of false
  # debugging loops during benchmarking.
  "$VENV_DIR/bin/browser-use" \
    --session "$BROWSER_USE_SESSION_NAME" \
    -b real \
    --headed \
    --profile "$SOURCE_PROFILE_NAME" \
    run \
    --llm o3 \
    --max-steps 25 \
    "Open emirates.com. Search one-way flights from Denpasar (DPS) to Dubai (DXB) for March 22, 2026. Stop as soon as visible flight options load. Report the top visible options and any obvious constraints. Do not purchase anything."
}

cmd="${1:-}"
case "$cmd" in
  setup)
    ensure_setup
    ;;
  doctor)
    doctor
    ;;
  prepare-profile)
    prepare_profile
    ;;
  run-emirates)
    run_emirates
    ;;
  *)
    usage
    exit 1
    ;;
esac
