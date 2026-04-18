#!/usr/bin/env bash
set -euo pipefail

# Render PlantUML sources under docs/UMLs to SVG (same directory as each .puml).
# Requires: plantuml on PATH (or java -jar plantuml.jar).
#
# Usage:
#   scripts/render-docs-umls.sh
#   scripts/render-docs-umls.sh docs/UMLs/foo.puml

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UMLS_DIR="${ROOT}/docs/UMLs"

if [[ ! -d "${UMLS_DIR}" ]]; then
  echo "render-docs-umls: missing ${UMLS_DIR}" >&2
  exit 1
fi

run_plantuml() {
  local file="$1"
  if command -v plantuml >/dev/null 2>&1; then
    plantuml -tsvg "${file}"
    return
  fi
  if [[ -n "${PLANTUML_JAR:-}" && -f "${PLANTUML_JAR}" ]]; then
    java -jar "${PLANTUML_JAR}" -tsvg "${file}"
    return
  fi
  echo "render-docs-umls: install plantuml or set PLANTUML_JAR to plantuml.jar" >&2
  exit 1
}

if [[ "$#" -gt 0 ]]; then
  for f in "$@"; do
    [[ -f "$f" ]] || { echo "render-docs-umls: not a file: $f" >&2; exit 1; }
    run_plantuml "$f"
  done
  exit 0
fi

count=0
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  count=$((count + 1))
  echo "Rendering ${f#"${ROOT}/"}"
  run_plantuml "$f"
done < <(find "${UMLS_DIR}" -maxdepth 1 -name '*.puml' -print | sort)
if [[ "$count" -eq 0 ]]; then
  echo "render-docs-umls: no .puml files in ${UMLS_DIR}" >&2
fi
