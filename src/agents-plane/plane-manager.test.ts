import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, IdentityProvider, InfraProvider, PlaneConfig } from "./types.js";
import { PlaneManager } from "./plane-manager.js";
import { LocalStateStore } from "./state/store.js";

function mockInfraProvider(): InfraProvider {
  return {
    name: "mock",
    provision: vi.fn().mockResolvedValue({
      instanceId: "vm-123",
      zone: "us-east4-a",
      serviceAccount: "agent@project.iam.gserviceaccount.com",
      ip: "10.0.0.5",
    }),
    deprovision: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ state: "running", ip: "10.0.0.5" }),
  };
}

function mockIdentityProvider(): IdentityProvider {
  return {
    name: "mock",
    resolveUser: vi.fn().mockResolvedValue({
      email: "alice@test.com",
      displayName: "Alice",
      agentEnabled: true,
    }),
    listUsers: vi.fn().mockResolvedValue([]),
  };
}

function makePlaneConfig(name = "test-plane"): PlaneConfig {
  return {
    name,
    identity: { provider: "google-workspace", domain: "test.com" },
    infra: {
      provider: "gcp",
      project: "test-project",
      region: "us-east4",
      defaults: { machineType: "e2-small", diskSizeGb: 20 },
    },
    secrets: { provider: "gcp-secret-manager", project: "test-project" },
    network: { provider: "iap" },
  };
}

function makeAgentConfig(name = "alice-agent"): AgentConfig {
  return {
    name,
    owner: "alice@test.com",
    modelTier: "sonnet",
    budgetCap: 50,
    tools: ["email", "calendar"],
    channels: ["email"],
  };
}

describe("PlaneManager", () => {
  let dir: string;
  let store: LocalStateStore;
  let infra: InfraProvider;
  let identity: IdentityProvider;
  let manager: PlaneManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-plane-mgr-"));
    store = new LocalStateStore(dir);
    infra = mockInfraProvider();
    identity = mockIdentityProvider();
    manager = new PlaneManager(infra, identity, store);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("createPlane", () => {
    it("creates a new plane", async () => {
      const state = await manager.createPlane(makePlaneConfig());
      expect(state.config.name).toBe("test-plane");
      expect(state.agents).toEqual({});
    });

    it("rejects duplicate plane names", async () => {
      await manager.createPlane(makePlaneConfig());
      await expect(manager.createPlane(makePlaneConfig())).rejects.toThrow(/already exists/);
    });
  });

  describe("addAgent", () => {
    it("provisions an agent end-to-end", async () => {
      await manager.createPlane(makePlaneConfig());
      const agent = await manager.addAgent("test-plane", makeAgentConfig());

      expect(agent.agentId).toBe("test-plane-alice-agent");
      expect(agent.compute.instanceId).toBe("vm-123");
      expect(agent.status).toBe("provisioning");
      expect(infra.provision).toHaveBeenCalledOnce();
    });

    it("validates owner exists in identity provider", async () => {
      (identity.resolveUser as any).mockResolvedValue(null);
      await manager.createPlane(makePlaneConfig());
      await expect(manager.addAgent("test-plane", makeAgentConfig())).rejects.toThrow(
        /not found in identity/,
      );
    });

    it("rejects duplicate agent names", async () => {
      await manager.createPlane(makePlaneConfig());
      await manager.addAgent("test-plane", makeAgentConfig());
      await expect(manager.addAgent("test-plane", makeAgentConfig())).rejects.toThrow(
        /already exists/,
      );
    });

    it("throws for non-existent plane", async () => {
      await expect(manager.addAgent("nope", makeAgentConfig())).rejects.toThrow(/not found/);
    });

    it("uses plane defaults for machine type", async () => {
      await manager.createPlane(makePlaneConfig());
      await manager.addAgent("test-plane", makeAgentConfig());
      const call = (infra.provision as any).mock.calls[0];
      expect(call[1].machineType).toBe("e2-small");
    });

    it("allows machine type override", async () => {
      await manager.createPlane(makePlaneConfig());
      const config = makeAgentConfig();
      config.machineType = "e2-medium";
      await manager.addAgent("test-plane", config);
      const call = (infra.provision as any).mock.calls[0];
      expect(call[1].machineType).toBe("e2-medium");
    });
  });

  describe("removeAgent", () => {
    it("deprovisions and removes agent", async () => {
      await manager.createPlane(makePlaneConfig());
      await manager.addAgent("test-plane", makeAgentConfig());
      await manager.removeAgent("test-plane", "alice-agent");

      expect(infra.deprovision).toHaveBeenCalledWith("test-plane-alice-agent");
      const agents = await manager.listAgents("test-plane");
      expect(agents).toHaveLength(0);
    });

    it("throws for non-existent agent", async () => {
      await manager.createPlane(makePlaneConfig());
      await expect(manager.removeAgent("test-plane", "nope")).rejects.toThrow(/not found/);
    });
  });

  describe("getStatus", () => {
    it("returns plane state", async () => {
      await manager.createPlane(makePlaneConfig());
      const status = await manager.getStatus("test-plane");
      expect(status.config.name).toBe("test-plane");
    });

    it("throws for non-existent plane", async () => {
      await expect(manager.getStatus("nope")).rejects.toThrow(/not found/);
    });
  });

  describe("listAgents", () => {
    it("lists all agents in plane", async () => {
      await manager.createPlane(makePlaneConfig());
      await manager.addAgent("test-plane", makeAgentConfig("agent-a"));
      await manager.addAgent("test-plane", makeAgentConfig("agent-b"));
      const agents = await manager.listAgents("test-plane");
      expect(agents).toHaveLength(2);
    });
  });

  describe("restartAgent", () => {
    it("restarts agent via infra provider", async () => {
      await manager.createPlane(makePlaneConfig());
      await manager.addAgent("test-plane", makeAgentConfig());
      await manager.restartAgent("test-plane", "alice-agent");
      expect(infra.restart).toHaveBeenCalledWith("vm-123");
    });

    it("throws for non-existent agent", async () => {
      await manager.createPlane(makePlaneConfig());
      await expect(manager.restartAgent("test-plane", "nope")).rejects.toThrow(/not found/);
    });
  });
});
