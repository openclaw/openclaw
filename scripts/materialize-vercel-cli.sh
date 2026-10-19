#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=63.1.0
expected_lock_sha256="0a83048049df839446b98af4a6d27b26b40903f9ca125e850965baa6cb590c6f"
expected_integrity="sha512-JQvJODfMeBGejhW1nfu0zfczU8I0NiARD3FilxuBjFeMtEzgK2LeBD6RC1yyhwR8mVQzod/p/SbjyDNFx11njQ=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
