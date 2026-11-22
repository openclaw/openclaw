#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=65.15.0
expected_lock_sha256="0952659900243ae878bd2cb30ad322b30ef7804b65ec107a642844d37dad7498"
expected_integrity="sha512-uejXkDZ1RdFAc5lg1+MN3kDbDnvT0fbChcVYvaHrZxaStG1cgKlLisk/9XicyOXDxEI6lF3WQZiRfviMNuXcXQ=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
