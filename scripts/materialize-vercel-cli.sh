#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=63.1.2
expected_lock_sha256="81a44227cdb0fdb14aeb166302ae0c44ccd91cd99ab9e19d95b507b53373bf74"
expected_integrity="sha512-kD/AKQVTV5Lwlg69fUNaW0OBGh6iSX42UTRrka10CtbOJDcxcqE8VoDRIuAsduGHiD3Hf90Ak9dX39nNzq8srA=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
