import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedOpenClawEnvConfig } from "../config/load.js";
import { generateCompose } from "./compose.js";

type ComposeService = {
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  tmpfs?: string[];
  working_dir?: string;
  user?: string;
  networks?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  entrypoint?: string[];
};

type ComposeLike = {
  services: Record<string, ComposeService>;
  networks?: Record<string, { internal?: boolean }>;
};

function asCompose(value: unknown): ComposeLike {
  return value as ComposeLike;
}

function baseResolvedConfig(
  overrides?: Partial<ResolvedOpenClawEnvConfig>,
): ResolvedOpenClawEnvConfig {
  const configDir = path.join(os.tmpdir(), "openclaw-env-test");
  const outputDir = path.join(configDir, ".openclaw-env");
  return {
    schema_version: "openclaw_env.v1",
    configPath: path.join(configDir, "openclaw.env.yml"),
    configDir,
    outputDir,
    projectName: "openclaw-env-test-12345678",
    openclaw: {
      image: "openclaw/openclaw:latest",
      env: {},
    },
    workspace: {
      hostPath: configDir,
      mode: "ro",
      writeAllowlist: [],
    },
    mounts: [],
    network: {
      mode: "off",
      restricted: { allowlist: [] },
    },
    secrets: {
      mode: "none",
      envFilePath: path.join(configDir, ".env.openclaw"),
      dockerSecrets: [],
    },
    limits: {
      cpus: 2,
      memory: "4g",
      pids: 256,
    },
    runtime: {
      user: "1000:1000",
    },
    writeGuards: {
      enabled: false,
      dryRunAudit: false,
      pollIntervalMs: 2000,
    },
    generated: {
      composePath: path.join(outputDir, "docker-compose.yml"),
      openclawConfigPath: path.join(outputDir, "openclaw.config.json5"),
      allowlistPath: path.join(outputDir, "allowlist.txt"),
      proxyDir: path.join(outputDir, "proxy"),
      proxyServerPath: path.join(outputDir, "proxy", "server.mjs"),
      proxyDockerfilePath: path.join(outputDir, "proxy", "Dockerfile"),
      writeGuardRunnerPath: path.join(outputDir, "write-guard.mjs"),
    },
    ...overrides,
  };
}

describe("generateCompose", () => {
  it("includes hardening defaults on openclaw service", () => {
    const cfg = baseResolvedConfig();
    const out = generateCompose(cfg);
    const compose = asCompose(out.composeObject);

    const svc = compose.services.openclaw;
    expect(svc.read_only).toBe(true);
    expect(svc.cap_drop).toEqual(["ALL"]);
    expect(svc.security_opt).toEqual(["no-new-privileges:true"]);
    expect(svc.tmpfs).toEqual(["/tmp", "/run", "/state"]);
    expect(svc.working_dir).toBe("/workspace");
    expect(svc.user).toBe("1000:1000");
  });

  it("wires restricted networking correctly", () => {
    const cfg = baseResolvedConfig({
      network: { mode: "restricted", restricted: { allowlist: ["api.openai.com"] } },
      workspace: { hostPath: "/tmp/work", mode: "ro", writeAllowlist: [] },
    });
    const out = generateCompose(cfg);
    const compose = asCompose(out.composeObject);

    expect(compose.networks.openclaw_internal.internal).toBe(true);
    expect(compose.services.openclaw.networks).toEqual(["openclaw_internal"]);
    expect(compose.services["egress-proxy"].networks).toEqual([
      "openclaw_internal",
      "openclaw_egress",
    ]);

    const env = compose.services.openclaw.environment;
    expect(env.HTTP_PROXY).toBe("http://egress-proxy:3128");
    expect(env.HTTPS_PROXY).toBe("http://egress-proxy:3128");
    expect(env.NO_PROXY).toContain("egress-proxy");
  });

  it("mounts workspace write allowlist as rw while workspace stays ro", () => {
    const cfg = baseResolvedConfig({
      workspace: {
        hostPath: "/tmp/work",
        mode: "ro",
        writeAllowlist: [
          {
            subpath: ".openclaw-cache",
            hostPath: "/tmp/work/.openclaw-cache",
            containerPath: "/workspace/.openclaw-cache",
          },
        ],
      },
    });
    const out = generateCompose(cfg);
    const compose = asCompose(out.composeObject);
    const volumes: string[] = compose.services.openclaw.volumes;
    expect(volumes).toContain("/tmp/work:/workspace:ro");
    expect(volumes).toContain("/tmp/work/.openclaw-cache:/workspace/.openclaw-cache:rw");
  });

  it("adds write guard entrypoint and config when enabled", () => {
    const cfg = baseResolvedConfig({
      workspace: {
        hostPath: "/tmp/work",
        mode: "ro",
        writeAllowlist: [
          {
            subpath: ".openclaw-cache",
            hostPath: "/tmp/work/.openclaw-cache",
            containerPath: "/workspace/.openclaw-cache",
          },
        ],
      },
      mounts: [{ hostPath: "/tmp/data", container: "/data", mode: "rw" }],
      writeGuards: {
        enabled: true,
        maxFileWrites: 5,
        maxBytesWritten: 1024,
        dryRunAudit: true,
        pollIntervalMs: 1500,
      },
    });
    const out = generateCompose(cfg);
    const compose = asCompose(out.composeObject);
    const svc = compose.services.openclaw;
    expect(Array.isArray(svc.entrypoint)).toBe(true);
    expect(svc.environment.OPENCLAW_ENV_WRITE_GUARDS).toContain('"dryRunAudit":true');
    expect(svc.environment.OPENCLAW_ENV_WRITE_GUARDS).toContain("/workspace/.openclaw-cache");
    expect(svc.environment.OPENCLAW_ENV_WRITE_GUARDS).toContain("/data");
    expect(out.writeGuardRunnerJs).toContain("write-guard");
  });
});
