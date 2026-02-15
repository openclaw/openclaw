#!/usr/bin/env bash
set -euo pipefail

# vm-bootstrap.sh
# Bootstraps a fresh Ubuntu/Debian VM for OpenClaw deployment.
# Installs Docker, Git, and runs the main docker-setup.sh script.

echo "==> OpenClaw VM Bootstrap"

if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (or via sudo)"
   exit 1
fi

echo "==> Updating package lists..."
apt-get update

echo "==> Installing prerequisites (git, curl)..."
apt-get install -y git curl

if ! command -v docker >/dev/null 2>&1; then
    echo "==> Installing Docker..."
    # Standard installation for Ubuntu/Debian
    apt-get install -y docker.io
    # Start and enable docker
    systemctl start docker
    systemctl enable docker
else
    echo "Docker already installed."
fi

# Ensure docker compose plugin is available (docker compose v2)
if ! docker compose version >/dev/null 2>&1; then
    echo "==> Installing Docker Compose Plugin..."
    apt-get install -y docker-compose-plugin || {
        echo "Failed to install docker-compose-plugin via apt. Trying standalone install..."
        mkdir -p /usr/local/lib/docker/cli-plugins
        curl -SL https://github.com/docker/compose/releases/download/v2.23.3/docker-compose-linux-$(uname -m) -o /usr/local/lib/docker/cli-plugins/docker-compose
        chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    }
fi

# Verify docker compose works
if ! docker compose version >/dev/null 2>&1; then
    echo "Error: docker compose is still not available."
    exit 1
fi

# Directory setup
INSTALL_DIR="/opt/openclaw"
if [[ -d .git && -f "package.json" ]]; then
    echo "Already inside a repository. Using current directory."
    INSTALL_DIR="$(pwd)"
else
    if [[ ! -d "$INSTALL_DIR" ]]; then
        echo "==> Cloning OpenClaw repository to $INSTALL_DIR..."
        git clone https://github.com/openclaw/openclaw.git "$INSTALL_DIR"
    else
        echo "Directory $INSTALL_DIR exists. Pulling latest changes..."
        cd "$INSTALL_DIR" && git pull
    fi
    cd "$INSTALL_DIR"
fi

echo "==> Running docker-setup.sh..."
# Allow running docker setup as current user if possible, but we are root here.
# If we want to run as a specific user, we might need adjustments, 
# but for a dedicated VM, running as root/default user is often acceptable 
# or expected for initial setup. 
# docker-setup.sh uses local directory binds.

./docker-setup.sh

echo ""
echo "==> VM Bootstrap Complete!"
echo "You can manage the service using 'docker compose' in $INSTALL_DIR"
