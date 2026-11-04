import { expect, it, vi } from "vitest";
import {
  createProviderTestHarness,
  commandResult,
  nodeEnrollmentFixture,
  catalogJson,
  classProfile,
} from "./crabbox-worker-provider.test-support.js";
vi.mock("./crabbox-managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crabbox-managed-binary.js")>()),
  ensureManagedCrabboxBinary: vi.fn(),
}));
const reply = (code = 0, stdout = "", stderr = "") => commandResult({ code, stdout, stderr });
const { createProvider } = createProviderTestHarness({ sleep: async () => {} }, "gateway-only-cbx");
const account = "123456789012",
  groupId = "sg-0123456789abcdef0",
  subnetId = "subnet-0123456789abcdef0",
  vpcId = "vpc-0123456789abcdef0",
  resourceId = "i-0123456789abcdef0";
function fixture(options: { denied?: boolean; managed?: boolean } = {}) {
  let allocated = false,
    metadataDisabled = false;
  const events: string[] = [];
  let leaseId = "";
  const config = {
    provider: "aws",
    coordinator: options.managed ? "https://example.invalid" : "",
    brokerMode: options.managed ? "managed" : "direct",
    tailscale: false,
    aws: { region: "us-east-1", securityGroupId: groupId, subnetId, instanceProfile: "" },
    env: { allow: [] },
    cache: { pnpm: false, npm: false, docker: false, git: false, volumes: [] },
  };
  const run = async (argv: string[], commandOptions: { input?: string | Uint8Array } = {}) => {
    if (argv[0] === "aws") {
      const op = argv[2];
      events.push("aws:" + op);
      let value: unknown = {};
      if (op === "get-caller-identity") {
        value = { Account: account };
      } else if (op === "describe-subnets") {
        value = {
          Subnets: [{ SubnetId: subnetId, VpcId: vpcId, OwnerId: account, State: "available" }],
        };
      } else if (op === "describe-vpcs") {
        value = {
          Vpcs: [
            {
              VpcId: vpcId,
              OwnerId: account,
              State: "available",
              CidrBlockAssociationSet: [
                { CidrBlock: "10.0.0.0/16", CidrBlockState: { State: "associated" } },
              ],
              Ipv6CidrBlockAssociationSet: [],
            },
          ],
        };
      } else if (op === "describe-route-tables") {
        value = {
          RouteTables: [
            {
              RouteTableId: "rtb-0123456789abcdef0",
              VpcId: vpcId,
              OwnerId: account,
              Associations: [{ Main: true }],
              Routes: [
                {
                  DestinationCidrBlock: "10.0.0.0/16",
                  GatewayId: "local",
                  Origin: "CreateRouteTable",
                  State: "active",
                },
                {
                  DestinationCidrBlock: "0.0.0.0/0",
                  GatewayId: "igw-0123456789abcdef0",
                  Origin: "CreateRoute",
                  State: "active",
                },
              ],
            },
          ],
        };
      } else if (op === "describe-internet-gateways") {
        value = {
          InternetGateways: [
            {
              InternetGatewayId: "igw-0123456789abcdef0",
              OwnerId: account,
              Attachments: [{ VpcId: vpcId, State: "available" }],
            },
          ],
        };
      } else if (op === "describe-security-groups") {
        value = {
          SecurityGroups: [
            {
              GroupId: groupId,
              OwnerId: account,
              VpcId: vpcId,
              IpPermissions: [],
              IpPermissionsEgress: [
                {
                  IpProtocol: "-1",
                  IpRanges: [{ CidrIp: options.denied ? "0.0.0.0/0" : "1.0.0.0/8" }],
                },
              ],
            },
          ],
        };
      } else if (op === "describe-instances") {
        value = {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: resourceId,
                  Tags: [{ Key: "lease", Value: leaseId }],
                  SubnetId: subnetId,
                  VpcId: vpcId,
                  State: { Name: allocated ? "running" : "terminated" },
                  SecurityGroups: [{ GroupId: groupId }],
                  MetadataOptions: {
                    HttpEndpoint: metadataDisabled ? "disabled" : "enabled",
                    State: "applied",
                  },
                  NetworkInterfaces: [
                    {
                      OwnerId: account,
                      SubnetId: subnetId,
                      VpcId: vpcId,
                      SourceDestCheck: true,
                      Ipv6Addresses: [],
                      Groups: [{ GroupId: groupId }],
                    },
                  ],
                },
              ],
            },
          ],
        };
      } else if (op === "modify-instance-metadata-options") {
        metadataDisabled = true;
      } else if (op === "terminate-instances") {
        allocated = false;
        value = { TerminatingInstances: [{ InstanceId: resourceId }] };
      } else if (op !== "wait") {
        throw new Error("Unexpected AWS operation " + op);
      }
      return reply(0, op === "wait" ? "" : JSON.stringify(value));
    }
    const action = argv[1];
    events.push("cbx:" + action);
    expect(
      argv.some(
        (arg) =>
          arg.includes("guest-network") ||
          arg.includes("untrusted-workload") ||
          arg.includes("expected-guest"),
      ),
    ).toBe(false);
    if (action === "config") {
      return reply(0, JSON.stringify(config));
    }
    if (action === "catalog") {
      return reply(0, catalogJson("aws", ["linux"], [classProfile("standard")]));
    }
    if (action === "warmup") {
      allocated = true;
      leaseId = argv[argv.indexOf("--lease-id") + 1]!;
      expect(argv).toContain("--profile=");
      return reply(0, "");
    }
    if (action === "inspect" || action === "status") {
      const id = argv[argv.indexOf("--id") + 1]!;
      if (!allocated) {
        return reply(1, "", "lease not found");
      }
      return reply(
        0,
        JSON.stringify({
          id,
          provider: "aws",
          serverId: resourceId,
          state: "RUNNING",
          ready: true,
          host: "1.1.1.1",
          sshHost: "1.1.1.1",
          sshPort: "22",
          sshUser: "ubuntu",
          tailscaleEnabled: false,
        }),
      );
    }
    if (action === "run") {
      expect(metadataDisabled).toBe(true);
      expect(commandOptions.input).toBeDefined();
      return reply(0, "");
    }
    if (action === "heartbeat") {
      return reply(0, "");
    }
    if (action === "stop") {
      allocated = false;
      return reply(0, "");
    }
    throw new Error("Unexpected released CLI operation " + action);
  };
  return {
    deny: () => {
      options.denied = true;
    },
    run,
    events,
    get leaseId() {
      return leaseId;
    },
  };
}
const profile = {
  provider: "aws",
  class: "standard",
  warmImage: false,
  ttl: "24h",
  idleTimeout: "60m",
};
const options = (recordResourceReceipt = async () => {}) => ({
  recordResourceReceipt,
  untrustedWorkload: true as const,
  beginNodeEnrollment: async () =>
    nodeEnrollmentFixture("synthetic-guest-node-setup", "Guest fixture"),
  assertCurrent: () => {},
});
it("automatically allocates with unchanged CLI semantics and qualifies AWS before guest node bootstrap", async () => {
  const f = fixture();
  const provider = createProvider({ runCommand: f.run });
  const lease = await provider.provision!(
    profile,
    "gateway-only-operation",
    options(async () => {
      f.events.push("gateway:record-receipt");
    }),
  );
  expect(lease.resourceReceipt?.identity).toMatchObject({
    provider: "aws",
    accountId: account,
    resourceId,
    securityGroupId: groupId,
  });
  expect(f.events.indexOf("aws:modify-instance-metadata-options")).toBeGreaterThan(
    f.events.indexOf("cbx:warmup"),
  );
  expect(f.events).toContain("gateway:record-receipt");
  expect(f.events.indexOf("gateway:record-receipt")).toBeLessThan(f.events.indexOf("cbx:run"));
  expect(f.events.indexOf("cbx:run")).toBeGreaterThan(
    f.events.indexOf("aws:modify-instance-metadata-options"),
  );
  await expect(provider.inspect!({ ...lease, profile })).resolves.toMatchObject({
    status: "active",
  });
  const nodeEffectsBefore = f.events.filter((event) => event === "cbx:run").length;
  f.deny();
  await expect(provider.inspect!({ ...lease, profile })).rejects.toThrow();
  expect(f.events.filter((event) => event === "cbx:run")).toHaveLength(nodeEffectsBefore);
  await provider.destroy!({ ...lease, profile, assertCurrent: () => {} });
  expect(f.events).toContain("aws:terminate-instances");
});
it.each([{ denied: true }, { managed: true }])(
  "rejects unqualified routes before any allocation: %j",
  async (failure) => {
    const f = fixture(failure);
    const provider = createProvider({ runCommand: f.run });
    await expect(provider.provision!(profile, "gateway-only-denied", options())).rejects.toThrow();
    expect(f.events).not.toContain("cbx:warmup");
    expect(f.events).not.toContain("cbx:run");
  },
);
