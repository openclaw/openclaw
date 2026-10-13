// OpenClaw cloud-init installer: builds Hetzner user_data that installs
// Docker + OpenClaw and configures the managed bot token. Follows
// docs/install/hetzner.md + docs/install/docker-vm-runtime.md (Docker path,
// SSH tunnel access, no public 18789).

export type OpenClawInstallInput = {
  botToken: string;
  gatewayToken: string;
  image?: string;
  telegramAllowFrom?: string[];
};

export function buildOpenClawUserData(input: OpenClawInstallInput): string {
  if (!input.botToken.trim()) {
    throw new Error("botToken is required");
  }
  if (!input.gatewayToken.trim()) {
    throw new Error("gatewayToken is required");
  }
  const image = input.image ?? "ghcr.io/openclaw/openclaw:latest";
  const allowFrom = (input.telegramAllowFrom ?? []).filter(Boolean).join(",");
  return [
    "#cloud-config",
    "package_update: true",
    "packages: [git, curl, ca-certificates, ufw]",
    "runcmd:",
    "  - ufw allow OpenSSH && ufw --force enable",
    "  - curl -fsSL https://get.docker.com | sh",
    "  - [sh, -c, 'grep -q AllowTcpForwarding /etc/ssh/sshd_config || echo \"AllowTcpForwarding local\" >> /etc/ssh/sshd_config']",
    "  - [sh, -c, 'sshd -t && systemctl restart ssh || systemctl restart sshd || true']",
    "  - git clone --depth 1 https://github.com/openclaw/openclaw.git /root/openclaw || (cd /root/openclaw && git pull --ff-only)",
    "  - |",
    `    cat > /root/openclaw/.env <<'EOF'`,
    `    OPENCLAW_GATEWAY_TOKEN=${input.gatewayToken}`,
    `    TELEGRAM_BOT_TOKEN=${input.botToken}`,
    `    OPENCLAW_IMAGE=${image}`,
    `    OPENCLAW_GATEWAY_BIND=127.0.0.1`,
    "    EOF",
    "  - |",
    "    sh -c 'cd /root/openclaw && \\",
    "      export OPENCLAW_CONFIG_DIR=/root/.openclaw OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace \\",
    `      OPENCLAW_AUTH_PROFILE_SECRET_DIR=/root/.openclaw-auth-profile-secrets OPENCLAW_IMAGE=${image} && \\`,
    "      ./scripts/docker/setup.sh' \\",
    `      ${allowFrom ? `&& printf '%s' '${allowFrom}' > /root/.openclaw/.telegram-allowfrom` : "&& true"}`,
    "  - echo openclaw-provisioned > /root/.openclaw-provisioned",
    "",
  ].join("\n");
}

export function buildGatewayHealthUrl(host: string, port = 18789): string {
  return `http://${host}:${port}/health`;
}

// Pure helper used by VERIFYING: a 2xx from the Gateway health endpoint
// (via SSH tunnel or tailnet in production) marks the install reachable.
export function isGatewayHealthyStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
