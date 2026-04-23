#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

python3 -m runbook_memory.tools.runbook_cli maintenance changed-docs
python3 -m runbook_memory.tools.runbook_cli maintenance stale-doc-queue
python3 -m runbook_memory.tools.runbook_cli maintenance duplicate-scan
python3 -m runbook_memory.tools.runbook_cli maintenance health-report
python3 -m runbook_memory.tools.runbook_cli maintenance eval-suite
