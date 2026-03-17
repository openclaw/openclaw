import { spawn } from "node:child_process";
import { getTailscaleDnsName } from "./webhook/tailscale.js";
async function startNgrokTunnel(config) {
  if (config.authToken) {
    await runNgrokCommand(["config", "add-authtoken", config.authToken]);
  }
  const args = ["http", String(config.port), "--log", "stdout", "--log-format", "json"];
  if (config.domain) {
    args.push("--domain", config.domain);
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolved = false;
    let publicUrl = null;
    let outputBuffer = "";
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        reject(new Error("ngrok startup timed out (30s)"));
      }
    }, 3e4);
    const processLine = (line) => {
      try {
        const log = JSON.parse(line);
        if (log.msg === "started tunnel" && log.url) {
          publicUrl = log.url;
        }
        if (log.addr && log.url && !publicUrl) {
          publicUrl = log.url;
        }
        if (publicUrl && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const fullUrl = publicUrl + config.path;
          console.log(`[voice-call] ngrok tunnel active: ${fullUrl}`);
          resolve({
            publicUrl: fullUrl,
            provider: "ngrok",
            stop: async () => {
              proc.kill("SIGTERM");
              await new Promise((res) => {
                proc.on("close", () => res());
                setTimeout(res, 2e3);
              });
            }
          });
        }
      } catch {
      }
    };
    proc.stdout.on("data", (data) => {
      outputBuffer += data.toString();
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          processLine(line);
        }
      }
    });
    proc.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("ERR_NGROK")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`ngrok error: ${msg}`));
        }
      }
    });
    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to start ngrok: ${err.message}`));
      }
    });
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok exited unexpectedly with code ${code}`));
      }
    });
  });
}
async function runNgrokCommand(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`ngrok command failed: ${stderr || stdout}`));
      }
    });
    proc.on("error", reject);
  });
}
async function isNgrokAvailable() {
  return new Promise((resolve) => {
    const proc = spawn("ngrok", ["version"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.on("close", (code) => {
      resolve(code === 0);
    });
    proc.on("error", () => {
      resolve(false);
    });
  });
}
async function startTailscaleTunnel(config) {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    throw new Error("Could not get Tailscale DNS name. Is Tailscale running?");
  }
  const path = config.path.startsWith("/") ? config.path : `/${config.path}`;
  const localUrl = `http://127.0.0.1:${config.port}${path}`;
  return new Promise((resolve, reject) => {
    const proc = spawn("tailscale", [config.mode, "--bg", "--yes", "--set-path", path, localUrl], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Tailscale ${config.mode} timed out`));
    }, 1e4);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        const publicUrl = `https://${dnsName}${path}`;
        console.log(`[voice-call] Tailscale ${config.mode} active: ${publicUrl}`);
        resolve({
          publicUrl,
          provider: `tailscale-${config.mode}`,
          stop: async () => {
            await stopTailscaleTunnel(config.mode, path);
          }
        });
      } else {
        reject(new Error(`Tailscale ${config.mode} failed with code ${code}`));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
async function stopTailscaleTunnel(mode, path) {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", [mode, "off", path], {
      stdio: "ignore"
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5e3);
    proc.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
async function startTunnel(config) {
  switch (config.provider) {
    case "ngrok":
      return startNgrokTunnel({
        port: config.port,
        path: config.path,
        authToken: config.ngrokAuthToken,
        domain: config.ngrokDomain
      });
    case "tailscale-serve":
      return startTailscaleTunnel({
        mode: "serve",
        port: config.port,
        path: config.path
      });
    case "tailscale-funnel":
      return startTailscaleTunnel({
        mode: "funnel",
        port: config.port,
        path: config.path
      });
    default:
      return null;
  }
}
export {
  isNgrokAvailable,
  startNgrokTunnel,
  startTailscaleTunnel,
  startTunnel
};
