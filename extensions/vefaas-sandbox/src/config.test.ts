import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildVefaasSandboxCreateSpec,
  createVefaasPluginConfigSchema,
  resolveVefaasPluginConfig,
} from "./config.js";

describe("vefaas plugin config", () => {
  it("applies defaults", () => {
    expect(resolveVefaasPluginConfig(undefined)).toEqual({
      mode: "remote",
      command: "openclaw-vefaas-sandbox",
      functionId: undefined,
      region: undefined,
      endpoint: undefined,
      image:
        "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/agent",
      ttlSeconds: 3600,
      timeoutMs: 120_000,
      resources: undefined,
      network: undefined,
      opencode: {
        entrypoint: "opencode",
        eventMode: "ndjson",
        artifactDir: "/workspace/.openclaw-artifacts",
        acp: false,
        env: {},
      },
    });
  });

  it("normalizes explicit production settings", () => {
    const resolved = resolveVefaasPluginConfig({
      command: "/usr/local/bin/vefaas-provisioner",
      functionId: "fn-123",
      region: "cn-beijing",
      endpoint: "https://vefaas.example",
      image: "registry.example/openclaw-opencode:prod",
      remoteWorkspaceDir: "/workspace/../workspace/project",
      remoteAgentWorkspaceDir: "/agent/./session",
      ttlSeconds: 7200,
      timeoutSeconds: 30,
      resources: {
        cpuCores: 2,
        memoryMiB: 4096,
      },
      network: {
        egress: "restricted",
        vpcId: "vpc-1",
      },
      opencode: {
        entrypoint: "opencode",
        eventMode: "ndjson",
        artifactDir: "/workspace/../workspace/artifacts",
        acp: true,
        env: {
          OPENAI_BASE_URL: "https://openai.example",
        },
      },
    });

    expect(resolved).toEqual({
      mode: "remote",
      command: "/usr/local/bin/vefaas-provisioner",
      functionId: "fn-123",
      region: "cn-beijing",
      endpoint: "https://vefaas.example",
      image: "registry.example/openclaw-opencode:prod",
      remoteWorkspaceDir: "/workspace/project",
      remoteAgentWorkspaceDir: "/agent/session",
      ttlSeconds: 7200,
      timeoutMs: 30_000,
      resources: {
        cpuCores: 2,
        memoryMiB: 4096,
      },
      network: {
        egress: "restricted",
        vpcId: "vpc-1",
      },
      opencode: {
        entrypoint: "opencode",
        eventMode: "ndjson",
        artifactDir: "/workspace/artifacts",
        acp: true,
        env: {
          OPENAI_BASE_URL: "https://openai.example",
        },
      },
    });
  });

  it("rejects mirror mode", () => {
    expect(() =>
      resolveVefaasPluginConfig({
        mode: "mirror",
      }),
    ).toThrow("mode must be remote");
  });

  it("rejects relative remote paths", () => {
    expect(() =>
      resolveVefaasPluginConfig({
        remoteWorkspaceDir: "workspace",
      }),
    ).toThrow("VEFaaS remoteWorkspaceDir must be absolute");
  });

  it("builds the create spec forwarded to the provisioner", () => {
    expect(
      buildVefaasSandboxCreateSpec(
        resolveVefaasPluginConfig({
          region: "cn-beijing",
          image: "registry.example/openclaw-opencode:prod",
          resources: {
            gpuCount: 1,
            gpuType: "v100",
          },
        }),
      ),
    ).toEqual({
      backend: "vefaas",
      mode: "remote",
      functionId: undefined,
      region: "cn-beijing",
      endpoint: undefined,
      image: "registry.example/openclaw-opencode:prod",
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/agent",
      ttlSeconds: 3600,
      resources: {
        gpuCount: 1,
        gpuType: "v100",
      },
      network: undefined,
      opencode: {
        entrypoint: "opencode",
        eventMode: "ndjson",
        artifactDir: "/workspace/.openclaw-artifacts",
        acp: false,
        env: {},
      },
    });
  });

  it("rejects relative opencode artifact dirs", () => {
    expect(() =>
      resolveVefaasPluginConfig({
        opencode: {
          artifactDir: "artifacts",
        },
      }),
    ).toThrow("VEFaaS opencode.artifactDir must be absolute");
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(createVefaasPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});
