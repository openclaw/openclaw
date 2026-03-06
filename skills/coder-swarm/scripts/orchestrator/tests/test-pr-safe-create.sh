#!/bin/bash
# Unit tests for pr-safe-create.sh fork-safety logic.
# Uses fake git repos with configurable remotes; does NOT call real gh.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PR_SAFE_CREATE="$SCRIPT_DIR/../bin/pr-safe-create.sh"

PASS=0
FAIL=0
ERRORS=()

assert_eq() {
    local label="$1"
    local expected="$2"
    local actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (expected='$expected', actual='$actual')"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label")
    fi
}

assert_contains() {
    local label="$1"
    local needle="$2"
    local haystack="$3"
    # Use -- to prevent grep treating needle as options (e.g. --repo)
    if echo "$haystack" | grep -qF -- "$needle"; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (needle='$needle' not found)"
        echo "        haystack: $haystack"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label")
    fi
}

# Run script under test, capture stdout/stderr and exit code
run_pr_safe() {
    local repo_dir="$1"
    shift
    # Extra PATH prefix may be passed as env before the args
    local extra_path="${STUB_PATH:-}"
    local out_file err_file
    out_file=$(mktemp)
    err_file=$(mktemp)
    local ec=0
    if [[ -n "$extra_path" ]]; then
        (cd "$repo_dir" && PATH="$extra_path:$PATH" bash "$PR_SAFE_CREATE" "$@" >"$out_file" 2>"$err_file") || ec=$?
    else
        (cd "$repo_dir" && bash "$PR_SAFE_CREATE" "$@" >"$out_file" 2>"$err_file") || ec=$?
    fi
    LAST_STDOUT=$(cat "$out_file")
    LAST_STDERR=$(cat "$err_file")
    LAST_EC=$ec
    rm -f "$out_file" "$err_file"
}

LAST_STDOUT=""
LAST_STDERR=""
LAST_EC=0

setup_repo() {
    local dir
    dir=$(mktemp -d)
    git -C "$dir" init -q
    git -C "$dir" config user.email "test@test.com"
    git -C "$dir" config user.name "Test"
    touch "$dir/file.txt"
    git -C "$dir" add .
    git -C "$dir" commit -q -m "init"
    echo "$dir"
}

add_remote() {
    git -C "$1" remote add "$2" "$3"
}

# Stub gh binary that just echoes its arguments
make_stub_gh() {
    local tmpbin
    tmpbin=$(mktemp -d)
    cat > "$tmpbin/gh" <<'EOF'
#!/bin/bash
echo "gh-stub $*"
exit 0
EOF
    chmod +x "$tmpbin/gh"
    echo "$tmpbin"
}

echo "=== Tests: pr-safe-create.sh ==="
echo ""

# ---- Test 1: no origin remote → error ----
echo "Test 1: no origin remote → non-zero exit with helpful message"
REPO=$(setup_repo)
run_pr_safe "$REPO" --title "T"
assert_eq "no origin → exit 1" 1 "$LAST_EC"
assert_contains "no origin → error message" "no 'origin' remote" "$LAST_STDERR"
rm -rf "$REPO"

# ---- Test 2: non-GitHub origin URL → error ----
echo ""
echo "Test 2: non-GitHub origin URL → error"
REPO=$(setup_repo)
add_remote "$REPO" "origin" "https://gitlab.com/foo/bar.git"
run_pr_safe "$REPO" --title "T"
assert_eq "non-GitHub URL → exit 1" 1 "$LAST_EC"
assert_contains "non-GitHub URL → error" "cannot parse GitHub owner/repo" "$LAST_STDERR"
rm -rf "$REPO"

# ---- Test 3: HTTPS origin only (no upstream) → calls gh --repo origin ----
echo ""
echo "Test 3: HTTPS origin only → gh pr create --repo myfork/myrepo"
REPO=$(setup_repo)
add_remote "$REPO" "origin" "https://github.com/myfork/myrepo.git"
GH_BIN=$(make_stub_gh)
STUB_PATH="$GH_BIN" run_pr_safe "$REPO" --title "My PR"
assert_eq "origin only → exit 0" 0 "$LAST_EC"
assert_contains "origin only → --repo myfork/myrepo" "--repo myfork/myrepo" "$LAST_STDOUT"
rm -rf "$REPO" "$GH_BIN"

# ---- Test 4: origin + unrelated upstream → warn, target origin ----
echo ""
echo "Test 4: origin + unrelated upstream → NOTE warning, target origin"
REPO=$(setup_repo)
add_remote "$REPO" "origin"   "https://github.com/myfork/myrepo.git"
add_remote "$REPO" "upstream" "https://github.com/someorg/myrepo.git"
GH_BIN=$(make_stub_gh)
STUB_PATH="$GH_BIN" run_pr_safe "$REPO" --title "T"
assert_eq "fork+upstream → exit 0" 0 "$LAST_EC"
assert_contains "fork+upstream → NOTE warning" "NOTE:" "$LAST_STDERR"
assert_contains "fork+upstream → targets origin" "--repo myfork/myrepo" "$LAST_STDOUT"
rm -rf "$REPO" "$GH_BIN"

# ---- Test 5: upstream = openclaw/openclaw, SWARM_PR_TARGET unset → refuse ----
echo ""
echo "Test 5: upstream is openclaw/openclaw, default → refuse"
REPO=$(setup_repo)
add_remote "$REPO" "origin"   "https://github.com/myfork/openclaw.git"
add_remote "$REPO" "upstream" "https://github.com/openclaw/openclaw.git"
GH_BIN=$(make_stub_gh)
STUB_PATH="$GH_BIN" run_pr_safe "$REPO" --title "T"
assert_eq "openclaw upstream, no override → exit 1" 1 "$LAST_EC"
assert_contains "openclaw upstream → error" "openclaw/openclaw" "$LAST_STDERR"
assert_contains "openclaw upstream → hint" "SWARM_PR_TARGET=upstream" "$LAST_STDERR"
rm -rf "$REPO" "$GH_BIN"

# ---- Test 6: upstream = openclaw/openclaw + SWARM_PR_TARGET=upstream → allowed ----
echo ""
echo "Test 6: upstream is openclaw/openclaw, SWARM_PR_TARGET=upstream → target upstream"
REPO=$(setup_repo)
add_remote "$REPO" "origin"   "https://github.com/myfork/openclaw.git"
add_remote "$REPO" "upstream" "https://github.com/openclaw/openclaw.git"
GH_BIN=$(make_stub_gh)
STUB_PATH="$GH_BIN" SWARM_PR_TARGET=upstream run_pr_safe "$REPO" --title "T"
assert_eq "SWARM_PR_TARGET=upstream → exit 0" 0 "$LAST_EC"
assert_contains "SWARM_PR_TARGET=upstream → targets upstream" "--repo openclaw/openclaw" "$LAST_STDOUT"
rm -rf "$REPO" "$GH_BIN"

# ---- Test 7: SSH-style remote URL ----
echo ""
echo "Test 7: SSH-style origin URL → parses correctly"
REPO=$(setup_repo)
add_remote "$REPO" "origin" "git@github.com:myfork/myrepo.git"
GH_BIN=$(make_stub_gh)
STUB_PATH="$GH_BIN" run_pr_safe "$REPO" --title "T"
assert_eq "SSH URL → exit 0" 0 "$LAST_EC"
assert_contains "SSH URL → --repo myfork/myrepo" "--repo myfork/myrepo" "$LAST_STDOUT"
rm -rf "$REPO" "$GH_BIN"

# ---- Test 8: SWARM_PR_TARGET=upstream but no upstream remote → falls back to origin ----
echo ""
echo "Test 8: SWARM_PR_TARGET=upstream but no upstream remote → targets origin"
REPO=$(setup_repo)
add_remote "$REPO" "origin" "https://github.com/myfork/myrepo.git"
GH_BIN=$(make_stub_gh)
STUB_PATH="$GH_BIN" SWARM_PR_TARGET=upstream run_pr_safe "$REPO" --title "T"
assert_eq "SWARM_PR_TARGET=upstream, no upstream remote → exit 0" 0 "$LAST_EC"
assert_contains "no upstream remote → uses origin" "--repo myfork/myrepo" "$LAST_STDOUT"
rm -rf "$REPO" "$GH_BIN"

# ---- Summary ----
echo ""
echo "============================="
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
    echo "Failed tests:"
    for e in "${ERRORS[@]}"; do
        echo "  - $e"
    done
    exit 1
fi
echo "All tests passed."
