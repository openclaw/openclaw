import { spawn } from "node:child_process";
function runTailscaleCommand(args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: -1, stdout: "" });
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}
async function getTailscaleSelfInfo() {
  const { code, stdout } = await runTailscaleCommand(["status", "--json"]);
  if (code !== 0) {
    return null;
  }
  try {
    const status = JSON.parse(stdout);
    return {
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
      nodeId: status.Self?.ID || null
    };
  } catch {
    return null;
  }
}
async function getTailscaleDnsName() {
  const info = await getTailscaleSelfInfo();
  return info?.dnsName ?? null;
}
async function setupTailscaleExposureRoute(opts) {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    console.warn("[voice-call] Could not get Tailscale DNS name");
    return null;
  }
  const { code } = await runTailscaleCommand([
    opts.mode,
    "--bg",
    "--yes",
    "--set-path",
    opts.path,
    opts.localUrl
  ]);
  if (code === 0) {
    const publicUrl = `https://${dnsName}${opts.path}`;
    console.log(`[voice-call] Tailscale ${opts.mode} active: ${publicUrl}`);
    return publicUrl;
  }
  console.warn(`[voice-call] Tailscale ${opts.mode} failed`);
  return null;
}
async function cleanupTailscaleExposureRoute(opts) {
  await runTailscaleCommand([opts.mode, "off", opts.path]);
}
async function setupTailscaleExposure(config) {
  if (config.tailscale.mode === "off") {
    return null;
  }
  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  return setupTailscaleExposureRoute({
    mode,
    path: config.tailscale.path,
    localUrl
  });
}
async function cleanupTailscaleExposure(config) {
  if (config.tailscale.mode === "off") {
    return;
  }
  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
}
export {
  cleanupTailscaleExposure,
  cleanupTailscaleExposureRoute,
  getTailscaleDnsName,
  getTailscaleSelfInfo,
  setupTailscaleExposure,
  setupTailscaleExposureRoute
};
