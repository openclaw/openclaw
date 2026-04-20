build_default_pr_changelog_entry() {
  local pr="$1"
  local contrib="$2"
  local title="$3"

  local trimmed_title
  trimmed_title=$(printf '%s' "$title" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -z "$trimmed_title" ]; then
    echo "Cannot build changelog entry: missing PR title."
    exit 1
  fi

  if [ -n "$contrib" ] && [ "$contrib" != "null" ]; then
    printf '%s (#%s). Thanks @%s\n' "$trimmed_title" "$pr" "$contrib"
    return 0
  fi

  printf '%s (#%s).\n' "$trimmed_title" "$pr"
}

ensure_pr_changelog_entry() {
  local pr="$1"
  local contrib="$2"
  local title="$3"
  local section="${4:-Changes}"
  local explicit_entry="${5:-}"

  [ -f CHANGELOG.md ] || {
    echo "CHANGELOG.md is missing."
    exit 1
  }

  local entry
  if [ -n "$explicit_entry" ]; then
    entry="$explicit_entry"
  else
    entry=$(build_default_pr_changelog_entry "$pr" "$contrib" "$title")
  fi
  local before_hash
  before_hash=$(sha256sum CHANGELOG.md | awk '{print $1}')

  local changelog_output
  changelog_output=$(bun scripts/changelog-add-unreleased.ts --section "${section,,}" "$entry")
  echo "$changelog_output"

  normalize_pr_changelog_entries "$pr"
  validate_changelog_merge_hygiene
  validate_changelog_entry_for_pr "$pr" "$contrib"

  local after_hash
  after_hash=$(sha256sum CHANGELOG.md | awk '{print $1}')
  if [ "$before_hash" = "$after_hash" ]; then
    echo "pr_changelog_changed=false"
  else
    echo "pr_changelog_changed=true"
  fi
}

resolve_pr_changelog_entry() {
  local pr="$1"
  local contrib="$2"
  local title="$3"

  local default_entry
  default_entry=$(build_default_pr_changelog_entry "$pr" "$contrib" "$title")

  if [ -n "${OPENCLAW_PR_CHANGELOG_ENTRY:-}" ]; then
    printf '%s\n' "$OPENCLAW_PR_CHANGELOG_ENTRY"
    return 0
  fi

  # Non-interactive contexts (CI, pipe, or explicit opt-in) use the default entry
  if [ ! -t 0 ] || [ -n "${CI:-}" ] || [ "${OPENCLAW_MERGE_NONINTERACTIVE:-}" = "1" ]; then
    printf '%s\n' "$default_entry"
    return 0
  fi

  echo "Default changelog entry:"
  echo "  $default_entry"
  echo "Press Enter to accept, or paste a replacement single-line entry."

  local answer
  read -r answer
  if [ -n "$answer" ]; then
    printf '%s\n' "$answer"
    return 0
  fi

  printf '%s\n' "$default_entry"
}

normalize_pr_changelog_entries() {
  local pr="$1"
  local changelog_path="CHANGELOG.md"

  [ -f "$changelog_path" ] || return 0

  PR_NUMBER_FOR_CHANGELOG="$pr" node <<'EOF_NODE'
const fs = require("node:fs");

const pr = process.env.PR_NUMBER_FOR_CHANGELOG;
const path = "CHANGELOG.md";
const original = fs.readFileSync(path, "utf8");
const lines = original.split("\n");
const prPattern = new RegExp(`(?:\\(#${pr}\\)|openclaw#${pr})`, "i");

function findActiveSectionIndex(arr) {
  return arr.findIndex((line) => line.trim() === "## Unreleased");
}

function findSectionEnd(arr, start) {
  for (let i = start + 1; i < arr.length; i += 1) {
    if (/^## /.test(arr[i])) {
      return i;
    }
  }
  return arr.length;
}

function ensureActiveSection(arr) {
  let activeIndex = findActiveSectionIndex(arr);
  if (activeIndex !== -1) {
    return activeIndex;
  }

  let insertAt = arr.findIndex((line, idx) => idx > 0 && /^## /.test(line));
  if (insertAt === -1) {
    insertAt = arr.length;
  }

  const block = ["## Unreleased", "", "### Changes", ""];
  if (insertAt > 0 && arr[insertAt - 1] !== "") {
    block.unshift("");
  }
  arr.splice(insertAt, 0, ...block);
  return findActiveSectionIndex(arr);
}

function contextFor(arr, index) {
  let major = "";
  let minor = "";
  for (let i = index; i >= 0; i -= 1) {
    const line = arr[i];
    if (!minor && /^### /.test(line)) {
      minor = line.trim();
    }
    if (/^## /.test(line)) {
      major = line.trim();
      break;
    }
  }
  return { major, minor };
}

function ensureSubsection(arr, subsection) {
  const activeIndex = ensureActiveSection(arr);
  const activeEnd = findSectionEnd(arr, activeIndex);
  const desired = subsection && /^### /.test(subsection) ? subsection : "### Changes";
  for (let i = activeIndex + 1; i < activeEnd; i += 1) {
    if (arr[i].trim() === desired) {
      return i;
    }
  }

  let insertAt = activeEnd;
  while (insertAt > activeIndex + 1 && arr[insertAt - 1] === "") {
    insertAt -= 1;
  }
  const block = ["", desired, ""];
  arr.splice(insertAt, 0, ...block);
  return insertAt + 1;
}

function sectionTailInsertIndex(arr, subsectionIndex) {
  let nextHeading = arr.length;
  for (let i = subsectionIndex + 1; i < arr.length; i += 1) {
    if (/^### /.test(arr[i]) || /^## /.test(arr[i])) {
      nextHeading = i;
      break;
    }
  }

  let insertAt = nextHeading;
  while (insertAt > subsectionIndex + 1 && arr[insertAt - 1] === "") {
    insertAt -= 1;
  }
  return insertAt;
}

function extractPrNumberFromLine(line) {
  // 与 TS 侧 extractPrNumber 对齐：只取第一个 PR 引用作为排序键
  const match = line.match(/(?:\(#(\d+)\)|openclaw#(\d+))/i);
  const raw = match && (match[1] || match[2]);
  if (!raw) {
    return undefined;
  }
  const num = Number.parseInt(raw, 10);
  return Number.isFinite(num) ? num : undefined;
}

function orderedInsertIndex(arr, subsectionIndex, nextHeading, newPr) {
  // 无 PR 号时 fallback 到尾插，保持旧行为
  if (newPr === undefined) {
    return sectionTailInsertIndex(arr, subsectionIndex);
  }
  for (let i = subsectionIndex + 1; i < nextHeading; i += 1) {
    const line = arr[i];
    if (!/^- /.test(line)) {
      continue;
    }
    const existing = extractPrNumberFromLine(line);
    if (existing === undefined) {
      continue;
    }
    if (existing > newPr) {
      return i;
    }
  }
  return sectionTailInsertIndex(arr, subsectionIndex);
}

ensureActiveSection(lines);

const moved = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!prPattern.test(lines[i])) {
    continue;
  }
  const ctx = contextFor(lines, i);
  if (ctx.major === "## Unreleased") {
    continue;
  }
  moved.push({
    line: lines[i],
    subsection: ctx.minor || "### Changes",
    index: i,
  });
}

if (moved.length === 0) {
  process.exit(0);
}

const removeIndexes = new Set(moved.map((entry) => entry.index));
const nextLines = lines.filter((_, idx) => !removeIndexes.has(idx));

for (const entry of moved) {
  const subsectionIndex = ensureSubsection(nextLines, entry.subsection);

  let nextHeading = nextLines.length;
  for (let i = subsectionIndex + 1; i < nextLines.length; i += 1) {
    if (/^### /.test(nextLines[i]) || /^## /.test(nextLines[i])) {
      nextHeading = i;
      break;
    }
  }

  const alreadyPresent = nextLines
    .slice(subsectionIndex + 1, nextHeading)
    .some((line) => line === entry.line);
  if (alreadyPresent) {
    continue;
  }

  const newPr = extractPrNumberFromLine(entry.line);
  const insertAt = orderedInsertIndex(nextLines, subsectionIndex, nextHeading, newPr);
  nextLines.splice(insertAt, 0, entry.line);
}

const updated = nextLines.join("\n");
if (updated !== original) {
  fs.writeFileSync(path, updated);
}
EOF_NODE
}

resolve_changelog_diff_range() {
  local env_file
  for env_file in .local/prep.env .local/prep-context.env; do
    [ -s "$env_file" ] || continue

    local candidate
    candidate=$(
      (
        set +u
        # shellcheck disable=SC1090
        source "$env_file" >/dev/null 2>&1 || exit 0
        printf '%s' "${PR_HEAD_SHA_BEFORE:-}"
      )
    )

    if [ -n "$candidate" ] \
      && git cat-file -e "${candidate}^{commit}" 2>/dev/null \
      && git merge-base --is-ancestor "$candidate" HEAD 2>/dev/null; then
      printf '%s\n' "${candidate}..HEAD"
      return 0
    fi
  done

  printf '%s\n' 'origin/main...HEAD'
}

validate_changelog_entry_for_pr() {
  local pr="$1"
  local contrib="$2"

  local pr_pattern
  pr_pattern="(#$pr|openclaw#$pr)"

  # 只验证三件事：
  #   1. 本 PR 条目存在于 ## Unreleased 之下
  #   2. 条目落在某个 ### 子 section 里
  #   3. 若有 contrib 信息，同一行含 `thanks @<contrib>`
  #
  # 不再对整个 section 做 PR 号全局单调性检查。PR 号升序只是插入策略
  # （由 src/infra/changelog-unreleased.ts 执行），不是存量不变式 ——
  # 历史 CHANGELOG 是按合并时间 append 的，本来就不严格升序，
  # 把它当硬门会让所有新 PR 都被卡住。
  local validation_output
  if ! validation_output=$(awk -v pr_pattern="$pr_pattern" '
BEGIN {
  current_release = ""
  current_section = ""
  issue_count = 0
  pr_count = 0
}
{
  if ($0 ~ /^## /) {
    current_release = $0
    current_section = ""
  } else if ($0 ~ /^### /) {
    current_section = $0
  }

  if ($0 ~ pr_pattern && current_release == "## Unreleased") {
    pr_lines[++pr_count] = FNR
    pr_text[FNR] = $0
    pr_sections[FNR] = current_section
  }
}
END {
  if (pr_count == 0) {
    printf "CHANGELOG.md update must reference PR pattern %s inside ## Unreleased.\n", pr_pattern
    exit 1
  }

  for (idx = 1; idx <= pr_count; idx++) {
    entry_line = pr_lines[idx]
    if (pr_sections[entry_line] == "") {
      printf "CHANGELOG.md entry must be inside a subsection (### ...): line %d: %s\n", entry_line, pr_text[entry_line]
      issue_count++
    }
  }

  if (issue_count > 0) {
    exit 1
  }

  print "changelog placement validated: PR-linked entry exists under ## Unreleased in a subsection"
}
' CHANGELOG.md); then
    printf '%s\n' "$validation_output"
    exit 1
  fi
  printf '%s\n' "$validation_output"

  if [ -n "$contrib" ] && [ "$contrib" != "null" ]; then
    local with_pr_and_thanks
    with_pr_and_thanks=$(awk -v pr_pattern="$pr_pattern" '
/^## / { current_release = $0 }
current_release == "## Unreleased" && $0 ~ pr_pattern { print }
' CHANGELOG.md | rg -i "thanks @$contrib" || true)
    if [ -z "$with_pr_and_thanks" ]; then
      echo "CHANGELOG.md update must include both PR #$pr and thanks @$contrib on the changelog entry line."
      exit 1
    fi
    echo "changelog validated: found PR #$pr + thanks @$contrib"
    return 0
  fi

  echo "changelog validated: found PR #$pr (contributor handle unavailable, skipping thanks check)"
}

validate_changelog_merge_hygiene() {
  local diff_range
  diff_range=$(resolve_changelog_diff_range)

  local diff
  diff=$(git diff --unified=0 "$diff_range" -- CHANGELOG.md)

  local removed_lines
  removed_lines=$(printf '%s\n' "$diff" | awk '
    /^---/ { next }
    /^-/ { print substr($0, 2) }
  ')
  if [ -z "$removed_lines" ]; then
    return 0
  fi

  local removed_refs
  removed_refs=$(printf '%s\n' "$removed_lines" | rg -o '#[0-9]+' | sort -u || true)
  if [ -z "$removed_refs" ]; then
    return 0
  fi

  local added_lines
  added_lines=$(printf '%s\n' "$diff" | awk '
    /^\+\+\+/ { next }
    /^\+/ { print substr($0, 2) }
  ')

  local ref
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    if ! printf '%s\n' "$added_lines" | rg -q -F "$ref"; then
      echo "CHANGELOG.md drops existing entry reference $ref without re-adding it."
      echo "Likely merge conflict loss; restore the dropped entry (or keep the same PR ref in rewritten text)."
      exit 1
    fi
  done <<<"$removed_refs"

  echo "changelog merge hygiene validated: no dropped PR references"
}
