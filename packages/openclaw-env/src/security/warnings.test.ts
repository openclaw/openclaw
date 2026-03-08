import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedOpenClawEnvConfig } from "../config/load.js";
import { evaluateSafety } from "./warnings.js";

function cfgWithMount(hostPath: string): ResolvedOpenClawEnvConfig {
  const configDir = path.join(os.tmpdir(), "openclaw-env-test");
  const outputDir = path.join(configDir, ".openclaw-env");
  return {
    schema_version: "openclaw_env.v1",
    configPath: path.join(configDir, "openclaw.env.yml"),
    configDir,
    outputDir,
    projectName: "openclaw-env-test-12345678",
    openclaw: { image: "openclaw/openclaw:latest", env: {} },
    workspace: { hostPath: configDir, mode: "ro", writeAllowlist: [] },
    mounts: [{ hostPath, container: "/data", mode: "ro" }],
    network: { mode: "off", restricted: { allowlist: [] } },
    secrets: {
      mode: "none",
      envFilePath: path.join(configDir, ".env.openclaw"),
      dockerSecrets: [],
    },
    limits: { cpus: 1, memory: "1g", pids: 128 },
    runtime: { user: "1000:1000" },
    writeGuards: { enabled: false, dryRunAudit: false, pollIntervalMs: 2000 },
    generated: {
      composePath: path.join(outputDir, "docker-compose.yml"),
      openclawConfigPath: path.join(outputDir, "openclaw.config.json5"),
      allowlistPath: path.join(outputDir, "allowlist.txt"),
      proxyDir: path.join(outputDir, "proxy"),
      proxyServerPath: path.join(outputDir, "proxy", "server.mjs"),
      proxyDockerfilePath: path.join(outputDir, "proxy", "Dockerfile"),
      writeGuardRunnerPath: path.join(outputDir, "write-guard.mjs"),
    },
  };
}

describe("evaluateSafety", () => {
  it("hard-errors on mounting docker.sock", () => {
    const res = evaluateSafety(cfgWithMount("/var/run/docker.sock"));
    expect(res.hardErrors.length).toBeGreaterThan(0);
    expect(res.hardErrors[0]?.code).toBe("mount_docker_sock");
  });

  it("requires override on mounting ~/.ssh", () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    const res = evaluateSafety(cfgWithMount(sshDir));
    expect(res.requiresOverride.length).toBeGreaterThan(0);
    expect(res.requiresOverride.some((f) => f.code === "mount_secret_dir")).toBe(true);
  });
});
