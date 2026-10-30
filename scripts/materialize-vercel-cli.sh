#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=64.4.0
expected_lock_sha256="1d7404eb04ff88303f53a7cb8c01070ecf29352cd239bd96b0cba2df9ac6a105"
expected_integrity="sha512-7MePR4liAcnMGLmlsP5DbBu1vIimakgNfzEqGTWOsBGIMk4gZ4qwRIPDandTecJM5fF7cgTtwHv+ev4gHxHSHg=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
