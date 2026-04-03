#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/docker/setup.sh"

if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "Docker setup script not found at $SCRIPT_PATH" >&2
  exit 1
fi

exec "$SCRIPT_PATH" "$@"

 # Add or update openclaw alias in ~/.bashrc to run via Docker
#
# This block ensures that users can run the `openclaw` command directly from their WSL (or Linux) shell, even though OpenClaw is running inside a Docker container.
# By creating (or updating) an alias in ~/.bashrc, any call to `openclaw` in the terminal will transparently execute the command inside the running Docker container (openclaw-openclaw-gateway-1).
#
# This approach provides a seamless developer experience:
#   - No need to remember or type long docker exec commands.
#   - The alias is persistent for all new terminal sessions.
#   - Users can use OpenClaw CLI tools as if they were installed natively on the host.
#   - It avoids confusion when switching between environments (WSL, native Linux, Docker).
#
# The script checks if an alias already exists and updates it if necessary, ensuring idempotency and preventing duplicate entries.
# This is especially useful in onboarding, CI, or when sharing setup scripts with teams.
if grep -q "alias openclaw=" ~/.bashrc 2>/dev/null; then
  sed -i 's|^alias openclaw=.*|alias openclaw="docker exec openclaw-openclaw-gateway-1 openclaw"|' ~/.bashrc
else
  echo 'alias openclaw="docker exec openclaw-openclaw-gateway-1 openclaw"' >> ~/.bashrc
fi
