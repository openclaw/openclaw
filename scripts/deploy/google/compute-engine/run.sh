#!/usr/bin/env bash
#
# Deploy OpenClaw to Google Compute Engine (follows docs/platforms/gcp.md)
#
# Usage:
#   ./scripts/deploy/google/compute-engine/run.sh [OPTIONS]
#
# Options:
#   --project PROJECT_ID    Google Cloud project ID (required)
#   --zone ZONE             Compute Engine zone (default: us-central1-a)
#   --instance NAME         Instance name (default: openclaw-gateway)
#   --machine-type TYPE     Machine type (default: e2-medium, 4GB RAM for builds)
#   --disk-size SIZE        Boot disk size (default: 20GB)
#   --env-file FILE         Upload .env file to the instance
#   --anthropic-key KEY     Anthropic API key
#   --gateway-token TOKEN   Gateway token (auto-generated if not provided)
#   --public                Expose gateway publicly to all IPs (not recommended)
#   --allowed-ip IP         Expose gateway but restrict to specific IP
#   --my-ip                 Auto-detect your IP, confirm, and restrict access to it (recommended)
#   --tailscale             Install Tailscale for HTTPS access (recommended)
#   --telegram-token TOKEN  Telegram bot token (from @BotFather)
#   --telegram-user-id ID   Your Telegram user ID (auto-approves you, skips pairing)
#   --help                  Show this help message
#
# Examples:
#   # Production deployment (e2-small, SSH tunnel access - most secure)
#   ./scripts/deploy/google/compute-engine/run.sh --project my-project --anthropic-key sk-ant-xxx
#
#   # Restrict access to your IP only (recommended - auto-detects and confirms)
#   ./scripts/deploy/google/compute-engine/run.sh --project my-project --anthropic-key sk-ant-xxx --my-ip
#
#   # Free tier deployment (e2-micro, may OOM under load)
#   ./scripts/deploy/google/compute-engine/run.sh --project my-project --machine-type e2-micro --anthropic-key sk-ant-xxx
#
#   # With .env file
#   ./scripts/deploy/google/compute-engine/run.sh --project my-project --env-file .env
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Google Cloud project with billing enabled
#
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values (following docs/platforms/gcp.md)
ZONE="us-central1-a"
INSTANCE_NAME="openclaw-gateway"
MACHINE_TYPE="e2-medium"
DISK_SIZE="20GB"
PROJECT_ID=""
ENV_FILE=""
ARG_ANTHROPIC_KEY=""
ARG_GATEWAY_TOKEN=""
GENERATED_GATEWAY_TOKEN=""
GENERATED_GOG_PASSWORD=""
PUBLIC_ACCESS=false
ALLOWED_IP=""
AUTO_DETECT_IP=false
INSTALL_TAILSCALE=false
TELEGRAM_BOT_TOKEN=""
TELEGRAM_USER_ID=""

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }
log_detail() { echo -e "    ${NC}↳ $1"; }

show_help() {
  head -38 "$0" | tail -36 | sed 's/^#//' | sed 's/^ //'
  exit 0
}

detect_my_ip() {
  echo ""
  log_info "Detecting your public IP address..."
  local my_ip
  my_ip=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s ipv4.icanhazip.com 2>/dev/null || echo "")
  if [[ -n "$my_ip" ]]; then
    echo ""
    echo "  Your IPv4 address: $my_ip"
    echo ""
    ALLOWED_IP="$my_ip"
    PUBLIC_ACCESS=true
  else
    log_error "Could not determine your IP address."
    log_detail "Try manually with: --allowed-ip YOUR_IP"
    exit 1
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --zone) ZONE="$2"; shift 2 ;;
    --instance) INSTANCE_NAME="$2"; shift 2 ;;
    --machine-type) MACHINE_TYPE="$2"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --anthropic-key) ARG_ANTHROPIC_KEY="$2"; shift 2 ;;
    --gateway-token) ARG_GATEWAY_TOKEN="$2"; shift 2 ;;
    --public) PUBLIC_ACCESS=true; shift ;;
    --allowed-ip) ALLOWED_IP="$2"; PUBLIC_ACCESS=true; shift 2 ;;
    --my-ip) AUTO_DETECT_IP=true; shift ;;
    --tailscale) INSTALL_TAILSCALE=true; shift ;;
    --telegram-token) TELEGRAM_BOT_TOKEN="$2"; shift 2 ;;
    --telegram-user-id) TELEGRAM_USER_ID="$2"; shift 2 ;;
    --help|-h) show_help ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate required arguments
if [[ -z "$PROJECT_ID" ]]; then
  log_error "Project ID is required. Use --project PROJECT_ID"
  echo ""
  echo "Usage: $0 --project YOUR_PROJECT_ID [OPTIONS]"
  exit 1
fi

# Auto-detect IP if --my-ip is set
if [[ "$AUTO_DETECT_IP" == "true" ]]; then
  detect_my_ip
  echo ""
  read -p "Restrict access to IP $ALLOWED_IP? [Y/n] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Nn]$ ]]; then
    log_error "Aborted. Use --allowed-ip IP to specify a different IP."
    exit 1
  fi
  log_success "Will restrict access to: $ALLOWED_IP"
fi

# Check prerequisites
check_prerequisites() {
  log_step "Checking prerequisites"

  log_info "Checking if gcloud CLI is installed..."
  if ! command -v gcloud &> /dev/null; then
    log_error "gcloud CLI is not installed!"
    log_detail "Install from: https://cloud.google.com/sdk/docs/install"
    exit 1
  fi
  log_detail "gcloud CLI found: $(which gcloud)"

  log_info "Checking gcloud authentication..."
  if ! gcloud auth print-access-token &> /dev/null; then
    log_error "Not authenticated with gcloud!"
    log_detail "Run: gcloud auth login"
    exit 1
  fi
  log_detail "Authenticated as: $(gcloud config get-value account 2>/dev/null)"

  log_info "Checking billing status..."
  local billing_enabled
  billing_enabled=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingEnabled)" 2>/dev/null || echo "false")
  if [[ "$billing_enabled" != "True" ]]; then
    log_error "Billing is not enabled for project: $PROJECT_ID"
    log_detail "Enable billing at: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
    exit 1
  fi
  log_detail "Billing is enabled"

  log_success "Prerequisites OK"
}

# Enable required APIs
enable_apis() {
  log_step "Enabling required APIs"

  log_info "Enabling Compute Engine API..."
  gcloud services enable compute.googleapis.com --project="$PROJECT_ID" 2>&1 || true
  log_success "Compute Engine API enabled"
}

# Create or get instance
create_instance() {
  log_step "Setting up Compute Engine instance"

  # Check if instance already exists
  log_info "Checking if instance exists..."
  if gcloud compute instances describe "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" &>/dev/null; then
    log_warn "Instance already exists: $INSTANCE_NAME"

    # Check current machine type and upgrade if needed
    local current_type
    current_type=$(gcloud compute instances describe "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" --format='value(machineType)' | sed 's|.*/||')
    log_detail "Current machine type: $current_type"

    # Upgrade if machine type is too small (e2-micro or e2-small cause OOM)
    if [[ "$current_type" == "e2-micro" || "$current_type" == "e2-small" ]]; then
      log_warn "Machine type $current_type has insufficient memory for builds (OOM risk)"
      log_info "Upgrading to $MACHINE_TYPE (4GB RAM)..."

      # Stop the instance
      log_detail "Stopping instance..."
      if ! gcloud compute instances stop "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" --quiet; then
        log_error "Failed to stop instance for upgrade"
        exit 1
      fi

      # Change machine type
      log_detail "Changing machine type to $MACHINE_TYPE..."
      if ! gcloud compute instances set-machine-type "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" --machine-type="$MACHINE_TYPE"; then
        log_error "Failed to change machine type"
        exit 1
      fi

      # Start the instance
      log_detail "Starting instance..."
      if ! gcloud compute instances start "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE"; then
        log_error "Failed to start instance"
        exit 1
      fi

      log_success "Upgraded to $MACHINE_TYPE"

      # Wait for instance to be ready
      log_info "Waiting for instance to be ready..."
      sleep 30
    else
      log_detail "Machine type OK: $current_type"
    fi

    return 0
  fi

  log_info "Creating new instance: $INSTANCE_NAME"
  log_detail "Zone: $ZONE"
  log_detail "Machine type: $MACHINE_TYPE"
  log_detail "Disk size: $DISK_SIZE"
  log_detail "Image: Debian 12"

  if gcloud compute instances create "$INSTANCE_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size="$DISK_SIZE" \
    --boot-disk-type=pd-standard \
    --tags=openclaw-server \
    --metadata=startup-script='#!/bin/bash
# Install Docker (following docs/platforms/gcp.md step 5)
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
usermod -aG docker $(logname 2>/dev/null || echo "")

echo "Docker installation complete"
'; then
    log_success "Instance created: $INSTANCE_NAME"
  else
    log_error "Failed to create instance"
    exit 1
  fi

  # Wait for instance to be ready
  log_info "Waiting for instance to be ready..."
  sleep 30

  # Wait for Docker to be installed
  log_info "Waiting for Docker installation..."
  local max_attempts=30
  local attempt=0
  while [[ $attempt -lt $max_attempts ]]; do
    if gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" --command="which docker" &>/dev/null; then
      log_success "Docker installed on instance"
      break
    fi
    attempt=$((attempt + 1))
    log_detail "Waiting... ($attempt/$max_attempts)"
    sleep 10
  done

  if [[ $attempt -ge $max_attempts ]]; then
    log_warn "Startup script may still be running. Will continue anyway."
  fi
}

# Create firewall rule (only if --public flag is used)
setup_firewall() {
  if [[ "$PUBLIC_ACCESS" != "true" ]]; then
    log_step "Firewall setup (loopback mode)"
    log_info "Gateway will be bound to loopback only"
    log_detail "Access via SSH tunnel: gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID -- -L 18789:127.0.0.1:18789"

    # Delete existing firewall rule if it exists (security: don't leave port open)
    if gcloud compute firewall-rules describe openclaw-gateway --project="$PROJECT_ID" &>/dev/null; then
      log_info "Removing existing firewall rule (not needed in loopback mode)..."
      gcloud compute firewall-rules delete openclaw-gateway --project="$PROJECT_ID" --quiet 2>/dev/null || true
      log_detail "Firewall rule removed"
    fi
    return
  fi

  # Determine source ranges
  local source_ranges="0.0.0.0/0"
  local access_mode="public access mode - open to all IPs"
  if [[ -n "$ALLOWED_IP" ]]; then
    source_ranges="${ALLOWED_IP}/32"
    access_mode="restricted access mode - only $ALLOWED_IP"
  fi

  log_step "Setting up firewall ($access_mode)"

  log_info "Checking firewall rule..."
  if gcloud compute firewall-rules describe openclaw-gateway --project="$PROJECT_ID" &>/dev/null; then
    log_detail "Firewall rule already exists, updating source ranges..."
    if gcloud compute firewall-rules update openclaw-gateway \
      --project="$PROJECT_ID" \
      --source-ranges="$source_ranges"; then
      log_success "Firewall rule updated with source: $source_ranges"
    else
      log_error "Failed to update firewall rule"
      exit 1
    fi

    # Verify the update worked
    local current_ranges
    current_ranges=$(gcloud compute firewall-rules describe openclaw-gateway --project="$PROJECT_ID" --format="value(sourceRanges)" 2>/dev/null || echo "")
    if [[ "$current_ranges" != *"$source_ranges"* ]] && [[ "$source_ranges" != "0.0.0.0/0" ]]; then
      log_warn "Firewall may not have updated correctly. Current: $current_ranges, Expected: $source_ranges"
    fi
  else
    log_info "Creating firewall rule for port 18789..."
    if gcloud compute firewall-rules create openclaw-gateway \
      --project="$PROJECT_ID" \
      --allow=tcp:18789 \
      --source-ranges="$source_ranges" \
      --target-tags=openclaw-server \
      --description="Allow OpenClaw gateway traffic"; then
      log_success "Firewall rule created with source: $source_ranges"
    else
      log_error "Failed to create firewall rule"
      exit 1
    fi
  fi
}

# Configure OpenClaw on the instance (following docs/platforms/gcp.md)
configure_openclaw() {
  log_step "Configuring OpenClaw (following docs/platforms/gcp.md)"

  # Resolve tokens
  local anthropic_key=""
  local gateway_token=""
  local gog_keyring_password=""

  # Get Anthropic key
  if [[ -n "$ARG_ANTHROPIC_KEY" ]]; then
    anthropic_key="$ARG_ANTHROPIC_KEY"
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    anthropic_key="$ANTHROPIC_API_KEY"
  elif [[ -n "$ENV_FILE" ]] && [[ -f "$ENV_FILE" ]]; then
    anthropic_key=$(grep "^ANTHROPIC_API_KEY=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true)
  fi

  if [[ -z "$anthropic_key" ]]; then
    log_error "Anthropic API key is required!"
    log_detail "Provide via --anthropic-key, ANTHROPIC_API_KEY env var, or in .env file"
    exit 1
  fi
  log_detail "Anthropic API key: ${anthropic_key:0:10}..."

  # Get or generate gateway token
  if [[ -n "$ARG_GATEWAY_TOKEN" ]]; then
    gateway_token="$ARG_GATEWAY_TOKEN"
  elif [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    gateway_token="$OPENCLAW_GATEWAY_TOKEN"
  elif [[ -n "$ENV_FILE" ]] && [[ -f "$ENV_FILE" ]]; then
    gateway_token=$(grep "^OPENCLAW_GATEWAY_TOKEN=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true)
  fi

  if [[ -z "$gateway_token" ]]; then
    log_info "Generating gateway token..."
    gateway_token=$(openssl rand -hex 32)
    GENERATED_GATEWAY_TOKEN="$gateway_token"
    log_detail "Token generated: ${gateway_token:0:16}..."
  else
    log_detail "Gateway token: ${gateway_token:0:16}..."
  fi

  # Get or generate GOG keyring password
  if [[ -n "$ENV_FILE" ]] && [[ -f "$ENV_FILE" ]]; then
    gog_keyring_password=$(grep "^GOG_KEYRING_PASSWORD=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true)
  fi

  if [[ -z "$gog_keyring_password" ]]; then
    log_info "Generating GOG keyring password..."
    gog_keyring_password=$(openssl rand -hex 32)
    GENERATED_GOG_PASSWORD="$gog_keyring_password"
    log_detail "GOG password generated"
  fi

  # Determine bind mode
  local bind_mode="lan"
  local port_binding="127.0.0.1:18789:18789"
  if [[ "$PUBLIC_ACCESS" == "true" ]] || [[ "$INSTALL_TAILSCALE" == "true" ]]; then
    # Tailscale needs access to the gateway, so bind to all interfaces
    bind_mode="lan"
    port_binding="18789:18789"
  fi

  # Get remote username
  local remote_user
  remote_user=$(gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" --command="whoami" 2>/dev/null || echo "")
  if [[ -z "$remote_user" ]]; then
    log_error "Could not determine remote username"
    exit 1
  fi
  log_detail "Remote user: $remote_user"

  # Build extra env vars from file (two formats: .env and docker-compose)
  local extra_env_vars=""
  local extra_env_file=""
  if [[ -n "$ENV_FILE" ]] && [[ -f "$ENV_FILE" ]]; then
    log_info "Reading additional variables from $ENV_FILE..."
    while IFS='=' read -r key value || [[ -n "$key" ]]; do
      # Skip comments and empty lines
      [[ -z "$key" || "$key" =~ ^# ]] && continue
      # Skip already handled keys
      [[ "$key" == "ANTHROPIC_API_KEY" || "$key" == "OPENCLAW_GATEWAY_TOKEN" || "$key" == "GOG_KEYRING_PASSWORD" ]] && continue
      # Add to docker-compose format
      extra_env_vars="${extra_env_vars}      - ${key}=${value}"$'\n'
      # Add to .env file format
      extra_env_file="${extra_env_file}${key}=${value}"$'\n'
      log_detail "Added: $key"
    done < "$ENV_FILE"
  fi

  # Add Telegram bot token if provided via command line
  if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
    extra_env_vars="${extra_env_vars}      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"$'\n'
    extra_env_file="${extra_env_file}TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"$'\n'
    log_detail "Added: TELEGRAM_BOT_TOKEN"
  fi

  # Build Tailscale volume mount if enabled
  local tailscale_volume=""
  if [[ "$INSTALL_TAILSCALE" == "true" ]]; then
    tailscale_volume="      - /var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock"$'\n'
  fi

  # Create remote setup script (following docs/platforms/gcp.md steps 6-11)
  log_info "Setting up OpenClaw on instance..."

  local setup_script='#!/bin/bash
set -e

REMOTE_USER="'"$remote_user"'"
HOME_DIR="/home/$REMOTE_USER"
INSTALL_TAILSCALE="'"$INSTALL_TAILSCALE"'"

echo "=== Step 6: Create persistent host directories ==="
mkdir -p "$HOME_DIR/.openclaw"
mkdir -p "$HOME_DIR/openclaw/workspace"
chown -R "$REMOTE_USER:$REMOTE_USER" "$HOME_DIR/.openclaw"
chown -R "$REMOTE_USER:$REMOTE_USER" "$HOME_DIR/openclaw/workspace"
echo "Created ~/.openclaw and ~/openclaw/workspace"

echo "=== Step 7: Clone OpenClaw repository ==="
cd "$HOME_DIR"
if [[ -d "openclaw" ]]; then
  echo "Repository already exists, pulling latest..."
  cd openclaw
  git pull || true
else
  git clone https://github.com/openclaw/openclaw.git
  cd openclaw
fi
chown -R "$REMOTE_USER:$REMOTE_USER" "$HOME_DIR/openclaw"

echo "=== Step 8: Configure environment variables ==="
cat > "$HOME_DIR/openclaw/.env" << EOF
# OpenClaw GCP Deployment Configuration
# Generated by deploy script (following docs/platforms/gcp.md)

OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN='"$gateway_token"'
OPENCLAW_GATEWAY_BIND='"$bind_mode"'
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=$HOME_DIR/.openclaw
OPENCLAW_WORKSPACE_DIR=$HOME_DIR/openclaw/workspace

GOG_KEYRING_PASSWORD='"$gog_keyring_password"'
XDG_CONFIG_HOME=/home/node/.openclaw

ANTHROPIC_API_KEY='"$anthropic_key"'
NODE_ENV=production

# Extra variables from --env-file or --telegram-token
'"$extra_env_file"'
EOF
chown "$REMOTE_USER:$REMOTE_USER" "$HOME_DIR/openclaw/.env"
chmod 600 "$HOME_DIR/openclaw/.env"
echo "Created .env file"

echo "=== Step 9: Create docker-compose.yml ==="
cat > "$HOME_DIR/openclaw/docker-compose.yml" << EOF
services:
  openclaw-gateway:
    image: \${OPENCLAW_IMAGE}
    build:
      context: .
      dockerfile: Dockerfile.gcp
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=\${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=\${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=\${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=\${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=\${XDG_CONFIG_HOME}
      - ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
'"$extra_env_vars"'
    volumes:
      - \${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - \${OPENCLAW_WORKSPACE_DIR}:/home/node/openclaw/workspace
'"$tailscale_volume"'    ports:
      - "'"$port_binding"'"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "\${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "\${OPENCLAW_GATEWAY_PORT}"
      ]
EOF
chown "$REMOTE_USER:$REMOTE_USER" "$HOME_DIR/openclaw/docker-compose.yml"
echo "Created docker-compose.yml"

echo "=== Step 10: Create Dockerfile.gcp ==="

# Build Tailscale installation command if enabled
TAILSCALE_INSTALL=""
if [[ "$INSTALL_TAILSCALE" == "true" ]]; then
  TAILSCALE_INSTALL="# Install Tailscale CLI (for tailscale serve)
RUN curl -fsSL https://tailscale.com/install.sh | sh"
fi

cat > "$HOME_DIR/openclaw/Dockerfile.gcp" << EOF
FROM node:22-bookworm

# Install system dependencies + Playwright/Chromium browser libs
RUN apt-get update && apt-get install -y \
    socat curl \
    # Chromium dependencies for Playwright browser
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    fonts-liberation xdg-utils \
    && rm -rf /var/lib/apt/lists/*

$TAILSCALE_INSTALL

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:\${PATH}"

# Optional: Add external binaries here if needed for specific skills
# Example (uncomment and adjust URL if binary exists):
# RUN curl -L https://example.com/binary.tar.gz | tar -xz -C /usr/local/bin

WORKDIR /app

# Copy package files first for better caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

# Security: Run as non-root user
USER node

CMD ["node", "dist/index.js"]
EOF
chown "$REMOTE_USER:$REMOTE_USER" "$HOME_DIR/openclaw/Dockerfile.gcp"
echo "Created Dockerfile.gcp"

echo "=== Step 11: Pre-configure gateway ==="

# Write config.json directly to the volume BEFORE starting the container
# This prevents the "Missing config" error that causes container restart loops
echo "Writing gateway configuration..."

# Build the config JSON
CONFIG_JSON="{
  \"gateway\": {
    \"mode\": \"local\",
    \"auth\": {
      \"mode\": \"token\"
    },
    \"controlUi\": {
      \"allowInsecureAuth\": true
    }
  }"

# Add Telegram config if token is present
if grep -q "TELEGRAM_BOT_TOKEN" "$HOME_DIR/openclaw/.env" 2>/dev/null; then
  # Check if we have a user ID for allowlist
  if [[ "'"$TELEGRAM_USER_ID"'" != "''" ]]; then
    CONFIG_JSON="$CONFIG_JSON,
  \"channels\": {
    \"telegram\": {
      \"enabled\": true,
      \"dmPolicy\": \"allowlist\",
      \"allowFrom\": [\"'"$TELEGRAM_USER_ID"'\"]
    }
  }"
    echo "Telegram configured with allowlist for user '"$TELEGRAM_USER_ID"'"
  else
    CONFIG_JSON="$CONFIG_JSON,
  \"channels\": {
    \"telegram\": {
      \"enabled\": true
    }
  }"
    echo "Telegram enabled (pairing required)"
  fi
fi

CONFIG_JSON="$CONFIG_JSON
}"

# Write config to the mounted volume
echo "$CONFIG_JSON" > "$HOME_DIR/.openclaw/config.json"
chown "$REMOTE_USER:$REMOTE_USER" "$HOME_DIR/.openclaw/config.json"
chmod 600 "$HOME_DIR/.openclaw/config.json"
echo "Config written to ~/.openclaw/config.json"

echo "=== Step 12: Build and launch ==="
cd "$HOME_DIR/openclaw"

# Ensure user can run docker
usermod -aG docker "$REMOTE_USER" 2>/dev/null || true

# Build the image
echo "Building Docker image (this may take several minutes)..."
docker compose build

# Start the gateway (config already exists, so it will start successfully)
echo "Starting OpenClaw gateway..."
docker compose up -d --force-recreate openclaw-gateway

# Wait for gateway to be ready
echo "Waiting for gateway to be ready..."
for i in {1..30}; do
  if curl -sf http://localhost:18789/health >/dev/null 2>&1; then
    echo "Gateway is ready!"
    break
  fi
  echo "  Waiting... ($i/30)"
  sleep 2
done

echo ""
echo "=== Step 13: Verify Gateway ==="
sleep 5
docker compose logs --tail=20 openclaw-gateway

echo ""
echo "Setup complete!"
'

  # Run setup script on instance
  echo "$setup_script" | gcloud compute ssh "$INSTANCE_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="sudo bash"

  log_success "OpenClaw configured and started"

  # Verify service is running and stays running
  log_info "Verifying gateway status (checking stability)..."
  local check_attempts=0
  local max_checks=6
  local stable_count=0
  local required_stable=3

  while [[ $check_attempts -lt $max_checks ]]; do
    sleep 5
    check_attempts=$((check_attempts + 1))

    local container_state
    container_state=$(gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
      --command="cd ~/openclaw && docker compose ps --format '{{.State}}' openclaw-gateway 2>/dev/null" 2>/dev/null || echo "")

    if [[ "$container_state" == "running" ]]; then
      stable_count=$((stable_count + 1))
      log_detail "Container running ($stable_count/$required_stable checks)..."
      if [[ $stable_count -ge $required_stable ]]; then
        log_success "OpenClaw gateway is running and stable"
        return 0
      fi
    else
      stable_count=0
      log_warn "Container not running (state: ${container_state:-unknown}), attempt $check_attempts/$max_checks"

      # Try to restart if container stopped
      if [[ $check_attempts -lt $max_checks ]]; then
        log_info "Attempting to restart container..."
        gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
          --command="cd ~/openclaw && docker compose up -d openclaw-gateway" 2>/dev/null || true
      fi
    fi
  done

  # If we get here, container is unstable
  log_error "Gateway container is not stable after $max_checks attempts"
  log_detail "Check logs with:"
  log_detail "gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID --command='cd ~/openclaw && docker compose logs --tail=50 openclaw-gateway'"
  exit 1
}

# Install and configure Tailscale for HTTPS access
install_tailscale() {
  if [[ "$INSTALL_TAILSCALE" != "true" ]]; then
    return
  fi

  log_step "Installing Tailscale for HTTPS access"

  log_info "Waiting for apt lock to be released (startup script may still be running)..."
  gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
    --command='for i in {1..30}; do sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; echo "Waiting for apt lock... ($i/30)"; sleep 5; done' 2>&1

  log_info "Installing Tailscale and jq on instance..."
  gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
    --command='sudo apt-get update && sudo apt-get install -y jq && curl -fsSL https://tailscale.com/install.sh | sh' 2>&1 || {
      log_warn "First attempt failed, retrying after 10s..."
      sleep 10
      gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
        --command='sudo apt-get update && sudo apt-get install -y jq && curl -fsSL https://tailscale.com/install.sh | sh' 2>&1 || true
    }

  log_info "Starting Tailscale (follow the auth link)..."
  echo ""
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║  TAILSCALE AUTHENTICATION REQUIRED                         ║"
  echo "║  Click the link below to authenticate:                     ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  echo ""

  gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
    --command='sudo tailscale up --hostname=openclaw-gateway' 2>&1

  # Get Tailscale hostname (try jq first, fallback to grep)
  TAILSCALE_HOSTNAME=$(gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
    --command='tailscale status --json 2>/dev/null | jq -r ".Self.DNSName // empty" 2>/dev/null | sed "s/\.$//"' 2>/dev/null || echo "")

  if [[ -z "$TAILSCALE_HOSTNAME" ]]; then
    log_warn "Could not get Tailscale hostname automatically"
    log_detail "Get it with: tailscale status"
    return
  fi

  log_success "Tailscale connected: $TAILSCALE_HOSTNAME"

  # Configure Tailscale Serve on HOST (must run with sudo on host, not from container)
  # Container cannot run tailscale serve due to permission issues
  log_info "Configuring Tailscale Serve to proxy HTTPS to port 18789..."
  gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
    --command='sudo tailscale serve --bg --yes 18789' 2>&1 || {
      log_warn "Could not configure Tailscale Serve automatically"
      log_detail "Run manually on instance: sudo tailscale serve --bg --yes 18789"
    }

  log_success "Tailscale Serve configured"
  log_success "Access URL: https://$TAILSCALE_HOSTNAME/"
}

# Get instance external IP
get_instance_ip() {
  gcloud compute instances describe "$INSTANCE_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
}

# Main
main() {
  echo ""
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║   OpenClaw Compute Engine Deployment                        ║"
  echo "║   (following docs/platforms/gcp.md)                        ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Configuration:"
  echo "  Project:       $PROJECT_ID"
  echo "  Zone:          $ZONE"
  echo "  Instance:      $INSTANCE_NAME"
  echo "  Machine type:  $MACHINE_TYPE"
  echo "  Disk size:     $DISK_SIZE"
  if [[ "$PUBLIC_ACCESS" == "true" ]]; then
    if [[ -n "$ALLOWED_IP" ]]; then
      echo "  Access mode:   Restricted to IP $ALLOWED_IP"
    else
      echo "  Access mode:   Public (open to all IPs)"
    fi
  else
    echo "  Access mode:   Loopback (SSH tunnel)"
  fi
  [[ "$INSTALL_TAILSCALE" == "true" ]] && echo "  Tailscale:     Yes (HTTPS)"
  [[ -n "$TELEGRAM_USER_ID" ]] && echo "  Telegram user: $TELEGRAM_USER_ID (auto-approved)"
  [[ -n "$ENV_FILE" ]] && echo "  Env file:      $ENV_FILE"
  echo ""

  check_prerequisites
  enable_apis
  create_instance
  setup_firewall
  install_tailscale  # Must run BEFORE Docker so Tailscale socket exists
  configure_openclaw

  local instance_ip
  instance_ip=$(get_instance_ip)

  echo ""
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║     Deployment Complete!                                   ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  echo ""
  log_success "Instance IP: $instance_ip"
  echo ""

  # Show generated secrets if we created them
  if [[ -n "${GENERATED_GATEWAY_TOKEN:-}" ]] || [[ -n "${GENERATED_GOG_PASSWORD:-}" ]]; then
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║  IMPORTANT: Save these generated secrets!                  ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    if [[ -n "${GENERATED_GATEWAY_TOKEN:-}" ]]; then
      echo "  OPENCLAW_GATEWAY_TOKEN=$GENERATED_GATEWAY_TOKEN"
    fi
    if [[ -n "${GENERATED_GOG_PASSWORD:-}" ]]; then
      echo "  GOG_KEYRING_PASSWORD=$GENERATED_GOG_PASSWORD"
    fi
    echo ""
    echo "  Save these securely - you'll need the gateway token to connect."
    echo ""
  fi

  # Access instructions based on mode
  if [[ "$INSTALL_TAILSCALE" == "true" ]] && [[ -n "${TAILSCALE_HOSTNAME:-}" ]]; then
    echo "Access (Tailscale HTTPS - secure, private network):"
    echo ""
    echo "  Prerequisites:"
    echo "    1. Install Tailscale on your device: https://tailscale.com/download"
    echo "    2. Log in with the same account used during deployment"
    echo ""
    echo "  Open dashboard (copy this URL):"
    if [[ -n "${GENERATED_GATEWAY_TOKEN:-}" ]]; then
      echo "    https://$TAILSCALE_HOSTNAME/?token=$GENERATED_GATEWAY_TOKEN"
    else
      echo "    https://$TAILSCALE_HOSTNAME/?token=YOUR_GATEWAY_TOKEN"
    fi
    echo ""
    echo "  Security: Only devices on YOUR Tailnet can access this URL."
    echo "            Even with the URL+token, others cannot connect."
  elif [[ "$PUBLIC_ACCESS" == "true" ]]; then
    echo "Access (public mode - WARNING: exposed to internet):"
    echo ""
    echo "  API/CLI access:"
    echo "    http://$instance_ip:18789"
    echo ""
    echo "  Test health:"
    echo "    curl http://$instance_ip:18789/health"
    echo ""
    echo "  Browser dashboard (requires SSH tunnel for WebSocket):"
    echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID -- -L 18789:127.0.0.1:18789"
    echo "    Then open: http://127.0.0.1:18789/"
    echo ""
    if [[ -n "${GENERATED_GATEWAY_TOKEN:-}" ]]; then
      echo "  Token: $GENERATED_GATEWAY_TOKEN"
    fi
    echo ""
    echo "  WARNING: HTTP over public IP does not work in browser dashboard."
    echo "           Browser requires HTTPS or localhost. Use --tailscale for HTTPS."
  else
    echo "Access (SSH tunnel mode - recommended for security):"
    echo ""
    echo "  Step 1: Create SSH tunnel from your laptop:"
    echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID -- -L 18789:127.0.0.1:18789"
    echo ""
    echo "  Step 2: Open in browser:"
    echo "    http://127.0.0.1:18789/"
    echo ""
    echo "  Step 3: Enter your gateway token"
    if [[ -n "${GENERATED_GATEWAY_TOKEN:-}" ]]; then
      echo "    Token: $GENERATED_GATEWAY_TOKEN"
    fi
  fi

  # Show Telegram info if configured
  if [[ -n "$TELEGRAM_USER_ID" ]]; then
    echo ""
    echo "Telegram:"
    echo "  Your user ID ($TELEGRAM_USER_ID) is pre-approved."
    echo "  Just message your bot - no pairing needed!"
  fi

  echo ""
  echo "Useful commands:"
  echo ""
  echo "  SSH to instance:"
  echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID"
  echo ""
  echo "  View logs:"
  echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID --command='cd ~/openclaw && docker compose logs -f'"
  echo ""
  echo "  Restart gateway:"
  echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID --command='cd ~/openclaw && docker compose restart'"
  echo ""
  echo "  Update OpenClaw:"
  echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID --command='cd ~/openclaw && git pull && docker compose build && docker compose up -d'"
  echo ""
  echo "What persists where:"
  echo "  ~/.openclaw  → Gateway config, OAuth tokens, WhatsApp session"
  echo "  ~/openclaw/workspace      → Agent workspace, code artifacts"
  echo "  Docker image → Application and dependencies"
  echo ""
  echo "Cloud Console:"
  echo "  https://console.cloud.google.com/compute/instancesDetail/zones/$ZONE/instances/$INSTANCE_NAME?project=$PROJECT_ID"
  echo ""

  # Show quick access URL at the very end for easy copy/click
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║  🚀 QUICK ACCESS - Copy and paste this URL:                ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  echo ""
  if [[ "$INSTALL_TAILSCALE" == "true" ]] && [[ -n "${TAILSCALE_HOSTNAME:-}" ]]; then
    if [[ -n "${GENERATED_GATEWAY_TOKEN:-}" ]]; then
      echo "  https://${TAILSCALE_HOSTNAME}/?token=${GENERATED_GATEWAY_TOKEN}"
    else
      echo "  https://${TAILSCALE_HOSTNAME}/"
    fi
    echo ""
    echo "  (Requires Tailscale installed on your device)"
  else
    echo "  Step 1: Run this command in a NEW terminal:"
    echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID -- -L 18789:127.0.0.1:18789"
    echo ""
    echo "  Step 2: Open this URL in your browser:"
    if [[ -n "${GENERATED_GATEWAY_TOKEN:-}" ]]; then
      echo "    http://127.0.0.1:18789/?token=${GENERATED_GATEWAY_TOKEN}"
    else
      echo "    http://127.0.0.1:18789/"
    fi
  fi
  echo ""
}

main
