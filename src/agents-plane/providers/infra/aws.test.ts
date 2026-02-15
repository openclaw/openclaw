import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentComputeSpec } from "../../types.js";
import { AwsInfraProvider } from "./aws.js";

function mockClients() {
  return {
    ec2: {
      send: vi.fn().mockImplementation((cmd: any) => {
        switch (cmd.__type) {
          case "RunInstances":
            return Promise.resolve({
              Instances: [
                {
                  InstanceId: "i-abc123",
                  Placement: { AvailabilityZone: "us-east-1a" },
                  PrivateIpAddress: "10.0.0.5",
                  State: { Name: "pending" },
                },
              ],
            });
          case "DescribeInstances":
            return Promise.resolve({
              Reservations: [
                {
                  Instances: [
                    {
                      InstanceId: "i-abc123",
                      State: { Name: "running" },
                      PrivateIpAddress: "10.0.0.5",
                    },
                  ],
                },
              ],
            });
          case "CreateSecurityGroup":
            return Promise.resolve({ GroupId: "sg-abc123" });
          case "TerminateInstances":
          case "StopInstances":
          case "StartInstances":
          case "DeleteSecurityGroup":
            return Promise.resolve({});
          default:
            return Promise.resolve({});
        }
      }),
    },
    iam: {
      send: vi.fn().mockImplementation((cmd: any) => {
        switch (cmd.__type) {
          case "CreateUser":
            return Promise.resolve({ User: { Arn: "arn:aws:iam::123:user/agent-test" } });
          default:
            return Promise.resolve({});
        }
      }),
    },
  };
}

const defaultSpec: AgentComputeSpec = {
  machineType: "t3.small",
  region: "us-east-1",
  diskSizeGb: 20,
  labels: { plane: "test", agent: "test-agent" },
};

describe("AwsInfraProvider", () => {
  let clients: ReturnType<typeof mockClients>;
  let provider: AwsInfraProvider;

  beforeEach(() => {
    clients = mockClients();
    provider = new AwsInfraProvider({
      region: "us-east-1",
      clients,
    });
  });

  describe("provision", () => {
    it("creates IAM user, security group, and EC2 instance", async () => {
      const result = await provider.provision("test-agent", defaultSpec, "#!/bin/bash\necho hi");

      // IAM: CreateUser + PutUserPolicy
      expect(clients.iam.send).toHaveBeenCalledTimes(2);
      // EC2: CreateSecurityGroup + RunInstances
      expect(clients.ec2.send).toHaveBeenCalledTimes(2);

      expect(result.instanceId).toBe("i-abc123");
      expect(result.zone).toBe("us-east-1a");
      expect(result.iamUser).toBe("arn:aws:iam::123:user/agent-test");
      expect(result.ip).toBe("10.0.0.5");
    });

    it("base64 encodes user data", async () => {
      await provider.provision("test-agent", defaultSpec, "#!/bin/bash\necho hello");
      const runCall = clients.ec2.send.mock.calls.find((c: any) => c[0].__type === "RunInstances");
      expect(runCall).toBeDefined();
      const decoded = Buffer.from(runCall![0].UserData, "base64").toString();
      expect(decoded).toContain("echo hello");
    });

    it("creates scoped IAM policy", async () => {
      await provider.provision("test-agent", defaultSpec, "");
      const policyCall = clients.iam.send.mock.calls.find(
        (c: any) => c[0].__type === "PutUserPolicy",
      );
      expect(policyCall).toBeDefined();
      const doc = JSON.parse(policyCall![0].PolicyDocument);
      expect(doc.Statement[0].Resource).toContain("agents/test-agent/");
    });

    it("creates security group with no ingress", async () => {
      await provider.provision("test-agent", defaultSpec, "");
      const sgCall = clients.ec2.send.mock.calls.find(
        (c: any) => c[0].__type === "CreateSecurityGroup",
      );
      expect(sgCall![0].GroupName).toBe("agent-test-agent");
      // No AuthorizeSecurityGroupIngress call
      const ingressCall = clients.ec2.send.mock.calls.find(
        (c: any) => c[0].__type === "AuthorizeSecurityGroupIngress",
      );
      expect(ingressCall).toBeUndefined();
    });
  });

  describe("deprovision", () => {
    it("terminates instance, deletes SG and IAM user", async () => {
      await provider.deprovision("test-agent");

      const types = clients.ec2.send.mock.calls.map((c: any) => c[0].__type);
      expect(types).toContain("DescribeInstances");
      expect(types).toContain("TerminateInstances");
      expect(types).toContain("DeleteSecurityGroup");

      const iamTypes = clients.iam.send.mock.calls.map((c: any) => c[0].__type);
      expect(iamTypes).toContain("DeleteUserPolicy");
      expect(iamTypes).toContain("DeleteUser");
    });

    it("handles missing instances gracefully", async () => {
      clients.ec2.send.mockImplementation((cmd: any) => {
        if (cmd.__type === "DescribeInstances") {
          return Promise.resolve({ Reservations: [] });
        }
        return Promise.resolve({});
      });
      await expect(provider.deprovision("test-agent")).resolves.toBeUndefined();
    });
  });

  describe("restart", () => {
    it("stops then starts the instance", async () => {
      await provider.restart("i-abc123");
      const types = clients.ec2.send.mock.calls.map((c: any) => c[0].__type);
      expect(types).toContain("StopInstances");
      expect(types).toContain("StartInstances");
    });
  });

  describe("status", () => {
    it("returns running status", async () => {
      const s = await provider.status("i-abc123");
      expect(s.state).toBe("running");
      expect(s.ip).toBe("10.0.0.5");
    });

    it("returns unknown on error", async () => {
      clients.ec2.send.mockRejectedValue(new Error("gone"));
      const s = await provider.status("i-abc123");
      expect(s.state).toBe("unknown");
    });
  });
});
