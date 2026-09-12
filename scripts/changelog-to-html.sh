#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

VERSION=${1:-}
CHANGELOG_FILE=${2:-}

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [changelog_file]" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -z "$CHANGELOG_FILE" ]]; then
  if [[ -f "$SCRIPT_DIR/../CHANGELOG.md" ]]; then
    CHANGELOG_FILE="$SCRIPT_DIR/../CHANGELOG.md"
  elif [[ -f "CHANGELOG.md" ]]; then
    CHANGELOG_FILE="CHANGELOG.md"
  elif [[ -f "../CHANGELOG.md" ]]; then
    CHANGELOG_FILE="../CHANGELOG.md"
  else
    echo "Error: Could not find CHANGELOG.md" >&2
    exit 1
  fi
fi

if [[ ! -f "$CHANGELOG_FILE" ]]; then
  echo "Error: Changelog file '$CHANGELOG_FILE' not found" >&2
  exit 1
fi

extract_version_section() {
  local version=$1
  local file=$2
  node --input-type=module - "$SCRIPT_DIR" "$version" "$file" <<'NODE'
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [scriptDir, version, file] = process.argv.slice(2);
const { findChangelogSection, findReleaseChangelog } = await import(
  pathToFileURL(path.join(scriptDir, "lib/release-changelog.mjs")).href
);
try {
  const markdown = path.basename(file) === "CHANGELOG.md"
    ? findReleaseChangelog({ rootDir: path.dirname(path.resolve(file)), version })?.section
    : readFileSync(file, "utf8");
  const section = markdown && findChangelogSection(markdown, version);
  if (section) process.stdout.write(section.replace(/^[^\n]*(?:\n|$)/u, ""));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
NODE
}

markdown_to_html() {
  # Keep substitution order and literal HTML unchanged, but process the whole
  # section once instead of spawning nine sed processes for every changelog line.
  sed \
    -e 's/^##### \(.*\)$/<h5>\1<\/h5>/' \
    -e 's/^#### \(.*\)$/<h4>\1<\/h4>/' \
    -e 's/^### \(.*\)$/<h3>\1<\/h3>/' \
    -e 's/^## \(.*\)$/<h2>\1<\/h2>/' \
    -e 's/^- \*\*\([^*]*\)\*\*\(.*\)$/<li><strong>\1<\/strong>\2<\/li>/' \
    -e 's/^- \([^*].*\)$/<li>\1<\/li>/' \
    -e 's/\*\*\([^*]*\)\*\*/<strong>\1<\/strong>/g' \
    -e 's/`\([^`]*\)`/<code>\1<\/code>/g' \
    -e 's/\[\([^]]*\)\](\([^)]*\))/<a href="\2">\1<\/a>/g'
}

version_content=$(extract_version_section "$VERSION" "$CHANGELOG_FILE")
if [[ -z "$version_content" ]]; then
  echo "<h2>OpenClaw $VERSION</h2>"
  echo "<p>Latest OpenClaw update.</p>"
  echo "<p><a href=\"https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md\">View full changelog</a></p>"
  exit 0
fi

echo "<h2>OpenClaw $VERSION</h2>"

{
  in_list=false
  while IFS= read -r line; do
    if [[ "$line" =~ ^- ]]; then
      if [[ "$in_list" == false ]]; then
        echo "<ul>"
        in_list=true
      fi
      printf '%s\n' "$line"
    else
      if [[ "$in_list" == true ]]; then
        echo "</ul>"
        in_list=false
      fi
      if [[ -n "$line" ]]; then
        printf '%s\n' "$line"
      fi
    fi
  done <<< "$version_content"

  if [[ "$in_list" == true ]]; then
    echo "</ul>"
  fi
} | markdown_to_html

echo "<p><a href=\"https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md\">View full changelog</a></p>"
