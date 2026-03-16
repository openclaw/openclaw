#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/telegram-e2e/userbot-common.sh
source "${SCRIPT_DIR}/userbot-common.sh"

userbot_send_live_main "$@"
