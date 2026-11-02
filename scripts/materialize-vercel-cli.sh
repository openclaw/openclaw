#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=64.7.0
expected_lock_sha256="1db1446b10416f8d95a388ab9c347f53672cead3a3da30a0bdcf0c5de2cb5c84"
expected_integrity="sha512-/2ze0K7OVfjDbh6eWQmCCOoAa3MDcbZX3OYljobcougiyqCMakLTAtj5H8aKubgD5IM1+otUMxvYcvlo6pv0Ng=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
