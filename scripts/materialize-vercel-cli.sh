#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=65.2.0
expected_lock_sha256="fff1062d18de0771a079bfd9533672d6e5018a102b83467480a2a6209e8bcb0a"
expected_integrity="sha512-IPalObt3xnaY9Njbwb3wbQR7ht0gyL3XYt4z1wjFui3r5pkJPKSAGaGSD4B5AX5B4tOXxSbnXpWnKx+RJgdKrg=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
