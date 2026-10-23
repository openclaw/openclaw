#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted ClawHub CLI source root is required}"
destination="${2:?ClawHub CLI destination is required}"
github_output="${3:-}"
cli_label=ClawHub
cli_package=clawhub
expected_version=0.23.3
expected_lock_sha256="8dc2d1dadd9c2423b87752c7fde83bf40018a30a46edb80166c43e458690f2b0"
expected_integrity="sha512-VwM6FQrZVarFRDiEqG42npUeyCu/iLhPnpO+b7kKIGRXv+TA6Lb8pboHnIgT6cmjFEnW3j/pTbshWeDQMQ7QWQ=="
additional_bin=""
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
