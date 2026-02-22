#!/usr/bin/env bash
# OpenClaw Ollama VPS setup
# Installs Ollama, configures it for external connections, and optionally pulls a model.
# Use on a VPS so OpenClaw (or other clients) can reach the API from outside localhost.
# See: https://docs.openclaw.ai/providers/ollama

set -e

echo "==> Installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh

echo "==> Configuring Ollama to accept external connections..."
# Add OLLAMA_HOST and OLLAMA_ORIGINS so OpenClaw (and other clients)
# can reach the API from outside localhost.
# Without this, Ollama binds to 127.0.0.1 only and external requests fail.
OLLAMA_SERVICE=/etc/systemd/system/ollama.service
if ! grep -q "OLLAMA_HOST" "$OLLAMA_SERVICE"; then
  sed -i 's|Environment="PATH=|Environment="OLLAMA_HOST=0.0.0.0"\nEnvironment="OLLAMA_ORIGINS=*"\nEnvironment="PATH=|' "$OLLAMA_SERVICE"
  echo "  OLLAMA_HOST=0.0.0.0 and OLLAMA_ORIGINS=* added to service."
else
  echo "  OLLAMA_HOST already set, skipping."
fi

echo "==> Fixing systemd-resolved DNS stability (if applicable)..."
# Prevents a known crash: Assertion 's->read_packet->family == AF_INET6' failed
# in systemd-resolved when DNS-over-TLS streams are used (Ubuntu 22.04/24.04).
if [ -d /etc/systemd/resolved.conf.d ] 2>/dev/null; then
  mkdir -p /etc/systemd/resolved.conf.d
  cat > /etc/systemd/resolved.conf.d/disable-dns-tcp.conf << 'EOF'
[Resolve]
DNSOverTLS=no
EOF
  systemctl restart systemd-resolved 2>/dev/null || true
  echo "  Applied systemd-resolved workaround."
else
  echo "  Skipping systemd-resolved (not present)."
fi

echo "==> Enabling Ollama as a systemd service..."
systemctl daemon-reload
systemctl enable ollama
systemctl start ollama

echo "==> Waiting for Ollama to be ready..."
for i in $(seq 1 10); do
  if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "  Ollama is up."
    break
  fi
  echo "  Waiting... ($i/10)"
  sleep 3
done

echo ""
echo "==> Choose a model to pull:"
echo "  1) llama3.1:8b (~4.9 GB, good general-purpose, recommended)"
echo "  2) llama3.2:3b (~2.0 GB, lighter, faster on low-RAM VPS)"
echo "  3) qwen2.5:7b (~4.7 GB, strong coding + reasoning)"
echo "  4) Skip (pull manually with: ollama pull)"
echo ""
read -rp "Enter choice [1-4]: " choice

case $choice in
  1) ollama pull llama3.1:8b ;;
  2) ollama pull llama3.2:3b ;;
  3) ollama pull qwen2.5:7b ;;
  4) echo "Skipping model pull." ;;
  *) echo "Invalid choice, skipping." ;;
esac

echo ""
echo "==> Ollama VPS setup complete."
echo "  API: http://localhost:11434"
echo "  External: http://$(hostname -I 2>/dev/null | awk '{print $1}'):11434"
echo ""
echo "==> Configure OpenClaw to use local mode with Ollama:"
echo "  openclaw config set gateway.mode local"
echo "  openclaw config set agents.defaults.model.primary ollama/llama3.1:8b"
echo "  # For remote VPS, set: openclaw config set models.providers.ollama.baseUrl http://YOUR_VPS_IP:11434"
echo ""
