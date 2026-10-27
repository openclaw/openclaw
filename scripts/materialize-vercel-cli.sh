#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=64.4.0
expected_lock_sha256="dc677fe4341e938feb9c7a938bcf7f449cfb436fd241b0d90aeece2e497da95f"
expected_integrity="sha512-7MePR4liAcnMGLmlsP5DbBu1vIimakgNfzEqGTWOsBGIMk4gZ4qwRIPDandTecJM5fF7cgTtwHv+ev4gHxHSHg=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
