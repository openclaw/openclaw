# Gateway Diagnostic Troubleshooting Guide

Quick diagnostic steps when the OpenClaw gateway is not responding.

## Quick Health Check

\`\`\`bash
# Check if gateway is running
systemctl status openclaw-gateway

# Check recent logs
journalctl -u openclaw-gateway --since "5 minutes ago" --no-pager

# Check port binding
ss -tlnp | grep -E '(3000|8080|9090)'
\`\`\`

## Common Issues

### 1. Gateway starts but channels don\'t connect

- Verify \`.env\' has correct tokens for each platform
- Check network connectivity: \`curl -s https://api.telegram.org/bot<TOKEN>/getMe\`
- Ensure webhook URLs are reachable from the internet

### 2. High memory usage

- Check for stuck sessions: \`openclaw status --sessions\`
- Restart with memory limit: \`NODE_OPTIONS="--max-old-space-size=2048" openclaw start\`
- Enable memory profiling: \`NODE_OPTIONS="--inspect" openclaw start\`

### 3. Slow responses / event loop blocked

- Check event loop lag: \`openclaw health --verbose\`
- Look for synchronous operations in plugins
- Enable event loop monitoring in config.yaml

### 4. Plugin errors

- List plugins: \`openclaw plugins list\`
- Disable suspect plugin: \`openclaw plugins disable <name>\`
- Check plugin logs: \`journalctl -u openclaw-gateway | grep plugin\`

## Advanced Diagnostics

\`\`\`bash
# Full diagnostic dump
openclaw doctor --full > /tmp/openclaw-diag.txt 2>&1

# Network connectivity check
openclaw health --probe --include-sensitive

# Config validation
openclaw config validate
\`\`\`
