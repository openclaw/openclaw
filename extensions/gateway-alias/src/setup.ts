import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { syncHostsFile, hostsFileIsUpToDate } from "./hosts.js";

const PF_ANCHOR = "com.openclaw.gateway-alias";
const PF_CONF_PATH = `/etc/pf.anchors/${PF_ANCHOR}`;

type SetupLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

const consoleLogger: SetupLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(`⚠ ${msg}`),
  error: (msg) => console.error(`✗ ${msg}`),
};

/**
 * Run the one-time setup for gateway-alias.
 *
 * This is designed to be invoked from the CLI with elevated privileges
 * (`openclaw gateway-alias setup` or `sudo openclaw gateway-alias setup`).
 *
 * Steps:
 * 1. Update /etc/hosts with alias hostnames
 * 2. (macOS) Configure pfctl port forwarding: port 80 → proxyPort
 * 3. (macOS) Install a LaunchDaemon to persist pfctl rules across reboots
 */
export async function runSetup(params: {
  aliases: Record<string, number>;
  proxyPort: number;
  log?: SetupLogger;
}): Promise<void> {
  const log = params.log ?? consoleLogger;
  const hostnames = Object.keys(params.aliases);
  const proxyPort = params.proxyPort;

  log.info("=== OpenClaw Gateway Alias Setup ===\n");

  // Step 1: Update /etc/hosts.
  log.info("→ Updating /etc/hosts...");
  const hostsOk = syncHostsFile(hostnames, log);
  if (hostsOk) {
    log.info(`  ✓ /etc/hosts entries: ${hostnames.join(", ")}`);
  } else {
    log.error("  ✗ Failed to update /etc/hosts (are you running with sudo?)");
  }

  // Step 2: macOS pfctl port forwarding.
  if (process.platform === "darwin") {
    log.info(`\n→ Setting up pfctl port forwarding (80 → ${proxyPort})...`);
    setupPfctl(proxyPort, log);
  } else if (process.platform === "linux") {
    log.info(`\n→ Setting up iptables port forwarding (80 → ${proxyPort})...`);
    setupIptables(proxyPort, log);
  } else {
    log.warn(
      `\nPort forwarding setup is not implemented for ${process.platform}. ` +
        `Configure your firewall to redirect port 80 → ${proxyPort} manually.`,
    );
  }

  log.info("\n=== Setup Complete ===\n");
  for (const [host, port] of Object.entries(params.aliases)) {
    log.info(`  http://${host} → localhost:${port}`);
  }
  log.info("\nRestart the gateway to activate the proxy.");
}

/**
 * macOS: Configure pfctl to redirect port 80 → proxy port on loopback.
 */
function setupPfctl(proxyPort: number, log: SetupLogger): void {
  try {
    // Write the pf anchor rule.
    const rule = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${proxyPort}\n`;
    writeFileSync(PF_CONF_PATH, rule, "utf-8");

    // Ensure the anchor is referenced in /etc/pf.conf.
    const pfConf = readFileSync("/etc/pf.conf", "utf-8");
    const rdrLine = `rdr-anchor "${PF_ANCHOR}"`;
    const loadLine = `load anchor "${PF_ANCHOR}" from "${PF_CONF_PATH}"`;

    if (!pfConf.includes(rdrLine)) {
      // Insert rdr-anchor after existing rdr-anchors, or at the top.
      let updated: string;
      const lastRdr = pfConf.lastIndexOf("rdr-anchor");
      if (lastRdr !== -1) {
        const nextNewline = pfConf.indexOf("\n", lastRdr);
        const insertAt = nextNewline !== -1 ? nextNewline + 1 : pfConf.length;
        updated =
          pfConf.slice(0, insertAt) + rdrLine + "\n" + loadLine + "\n" + pfConf.slice(insertAt);
      } else {
        updated = rdrLine + "\n" + loadLine + "\n" + pfConf;
      }
      writeFileSync("/etc/pf.conf", updated, "utf-8");
    } else if (!pfConf.includes(loadLine)) {
      // rdr-anchor exists but load anchor is missing.
      const rdrIdx = pfConf.indexOf(rdrLine);
      const nextNewline = pfConf.indexOf("\n", rdrIdx);
      const insertAt = nextNewline !== -1 ? nextNewline + 1 : pfConf.length;
      const updated = pfConf.slice(0, insertAt) + loadLine + "\n" + pfConf.slice(insertAt);
      writeFileSync("/etc/pf.conf", updated, "utf-8");
    }

    // Reload pf rules.
    execSync("pfctl -ef /etc/pf.conf 2>/dev/null", { stdio: "pipe" });
    log.info(`  ✓ pfctl: port 80 → ${proxyPort} on lo0`);

    // Install a LaunchDaemon so pfctl rules persist across reboots.
    const plistPath = `/Library/LaunchDaemons/${PF_ANCHOR}.plist`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PF_ANCHOR}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/sbin/pfctl</string>
        <string>-ef</string>
        <string>/etc/pf.conf</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/openclaw-gateway-alias-pf.err</string>
</dict>
</plist>`;
    writeFileSync(plistPath, plist, "utf-8");
    try {
      execSync(`launchctl load -w "${plistPath}" 2>/dev/null`, { stdio: "pipe" });
    } catch {
      // May already be loaded; that's fine.
    }
    log.info("  ✓ LaunchDaemon installed (pfctl rules persist across reboots)");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`  pfctl setup failed: ${message}`);
    log.warn("  Make sure you are running with: sudo openclaw gateway-alias setup");
  }
}

/**
 * Linux: Configure iptables to redirect port 80 → proxy port.
 */
function setupIptables(proxyPort: number, log: SetupLogger): void {
  try {
    // Remove any existing rule first (idempotent).
    try {
    const portStr = String(Math.floor(proxyPort));
    if (!/^\d+$/.test(portStr)) {
      throw new Error(`Invalid port: ${proxyPort}`);
    }
    try {
      execSync(
        `iptables -t nat -D OUTPUT -p tcp --dport 80 -j REDIRECT --to-port ${portStr} 2>/dev/null`,
        { stdio: "pipe" },
      );
        { stdio: "pipe" },
      );
    } catch {
      // Rule didn't exist — that's fine.
    }

    execSync(`iptables -t nat -A OUTPUT -p tcp --dport 80 -j REDIRECT --to-port ${portStr}`, {
      stdio: "pipe",
    });
    log.info(`  ✓ iptables: port 80 → ${proxyPort}`);
    log.warn("  Note: iptables rules are not persistent. Use iptables-persistent or similar.");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`  iptables setup failed: ${message}`);
    log.warn("  Make sure you are running with: sudo openclaw gateway-alias setup");
  }
}
