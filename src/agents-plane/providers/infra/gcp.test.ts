import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentComputeSpec } from "../../types.js";
import { GcpInfraProvider } from "./gcp.js";

function mockClients() {
  return {
    instances: {
      insert: vi.fn().mockResolvedValue([{ name: "op-1" }]),
      get: vi.fn().mockResolvedValue([
        {
          name: "test-agent",
          status: "RUNNING",
          networkInterfaces: [{ networkIP: "10.0.0.5" }],
        },
      ]),
      delete: vi.fn().mockResolvedValue([{}]),
      stop: vi.fn().mockResolvedValue([{}]),
      start: vi.fn().mockResolvedValue([{}]),
    },
    firewalls: {
      insert: vi.fn().mockResolvedValue([{}]),
      delete: vi.fn().mockResolvedValue([{}]),
    },
    iam: {
      createServiceAccount: vi.fn().mockResolvedValue([{}]),
      deleteServiceAccount: vi.fn().mockResolvedValue([{}]),
    },
  };
}

const defaultSpec: AgentComputeSpec = {
  machineType: "e2-small",
  region: "us-east4",
  diskSizeGb: 20,
  labels: { plane: "test", agent: "test-agent" },
};

describe("GcpInfraProvider", () => {
  let clients: ReturnType<typeof mockClients>;
  let provider: GcpInfraProvider;

  beforeEach(() => {
    clients = mockClients();
    provider = new GcpInfraProvider({
      project: "test-project",
      defaultZone: "us-east4-a",
      clients,
    });
  });

  describe("provision", () => {
    it("creates SA, firewall, and VM", async () => {
      const result = await provider.provision("test-agent", defaultSpec, "#!/bin/bash\necho hi");

      expect(clients.iam.createServiceAccount).toHaveBeenCalledOnce();
      expect(clients.firewalls.insert).toHaveBeenCalledOnce();
      expect(clients.instances.insert).toHaveBeenCalledOnce();

      expect(result.instanceId).toBe("test-agent");
      expect(result.zone).toBe("us-east4-a");
      expect(result.serviceAccount).toBe("test-agent@test-project.iam.gserviceaccount.com");
      expect(result.ip).toBe("10.0.0.5");
    });

    it("uses custom zone from spec", async () => {
      await provider.provision("test-agent", { ...defaultSpec, zone: "us-east4-b" }, "");
      const call = clients.instances.insert.mock.calls[0][0];
      expect(call.zone).toBe("us-east4-b");
    });

    it("sets startup script in metadata", async () => {
      await provider.provision("test-agent", defaultSpec, "#!/bin/bash\necho hello");
      const call = clients.instances.insert.mock.calls[0][0];
      const metadata = call.instanceResource.metadata.items;
      expect(metadata).toContainEqual({ key: "startup-script", value: "#!/bin/bash\necho hello" });
    });

    it("creates VM without external IP", async () => {
      await provider.provision("test-agent", defaultSpec, "");
      const call = clients.instances.insert.mock.calls[0][0];
      const iface = call.instanceResource.networkInterfaces[0];
      expect(iface.accessConfigs).toBeUndefined();
    });

    it("sets labels on VM", async () => {
      await provider.provision("test-agent", defaultSpec, "");
      const call = clients.instances.insert.mock.calls[0][0];
      expect(call.instanceResource.labels).toEqual({ plane: "test", agent: "test-agent" });
    });

    it("targets firewall to agent tag", async () => {
      await provider.provision("test-agent", defaultSpec, "");
      const call = clients.firewalls.insert.mock.calls[0][0];
      expect(call.firewallResource.targetTags).toEqual(["test-agent"]);
      expect(call.firewallResource.sourceRanges).toEqual(["35.235.240.0/20"]);
    });
  });

  describe("deprovision", () => {
    it("deletes VM, firewall, and SA", async () => {
      await provider.deprovision("test-agent");
      expect(clients.instances.delete).toHaveBeenCalledOnce();
      expect(clients.firewalls.delete).toHaveBeenCalledOnce();
      expect(clients.iam.deleteServiceAccount).toHaveBeenCalledOnce();
    });

    it("ignores 404 on VM delete", async () => {
      clients.instances.delete.mockRejectedValue({ code: 404 });
      await expect(provider.deprovision("test-agent")).resolves.toBeUndefined();
    });

    it("ignores 404 on SA delete", async () => {
      clients.iam.deleteServiceAccount.mockRejectedValue({ code: 404 });
      await expect(provider.deprovision("test-agent")).resolves.toBeUndefined();
    });
  });

  describe("restart", () => {
    it("stops then starts the instance", async () => {
      await provider.restart("test-agent");
      expect(clients.instances.stop).toHaveBeenCalledOnce();
      expect(clients.instances.start).toHaveBeenCalledOnce();
    });
  });

  describe("status", () => {
    it("returns running status", async () => {
      const s = await provider.status("test-agent");
      expect(s.state).toBe("running");
      expect(s.ip).toBe("10.0.0.5");
    });

    it("maps stopped status", async () => {
      clients.instances.get.mockResolvedValue([{ status: "STOPPED" }]);
      const s = await provider.status("test-agent");
      expect(s.state).toBe("stopped");
    });

    it("returns unknown on error", async () => {
      clients.instances.get.mockRejectedValue(new Error("not found"));
      const s = await provider.status("test-agent");
      expect(s.state).toBe("unknown");
    });
  });
});
