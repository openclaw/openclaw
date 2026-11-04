import { beforeEach, expect, it, vi } from "vitest";
import { runCrabboxProcess } from "./crabbox-process.js";
import { assertPublicAwsCidr, assertGuestVpcRoutes } from "./crabbox-worker-gateway-aws-policy.js";
import {
  prepareGatewayAwsGuestBoundary,
  qualifyGatewayAwsGuestResource,
  deleteGatewayAwsGuestResource,
} from "./crabbox-worker-gateway-aws.js";
vi.mock("./crabbox-process.js", () => ({ runCrabboxProcess: vi.fn() }));
const run = vi.mocked(runCrabboxProcess);
const account = "123456789012",
  groupId = "sg-0123456789abcdef0",
  subnetId = "subnet-0123456789abcdef0",
  vpcId = "vpc-0123456789abcdef0",
  resourceId = "i-0123456789abcdef0";
const config = {
  provider: "aws",
  coordinator: "",
  brokerMode: "direct",
  aws: { region: "us-east-1", securityGroupId: groupId, subnetId, instanceProfile: "" },
};
let group: Record<string, unknown>,
  instance: Record<string, unknown>,
  current: boolean,
  deleted: boolean;
let hook: ((operation: string) => Promise<void>) | undefined;
const assertCurrent = () => {
  if (!current) {
    throw new Error("lease owner revoked");
  }
};
const authority = () => ({ provider: "aws", assertCurrent });
beforeEach(() => {
  current = true;
  deleted = false;
  hook = undefined;
  group = {
    GroupId: groupId,
    OwnerId: account,
    VpcId: vpcId,
    IpPermissions: [
      { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "1.1.1.1/32" }] },
    ],
    IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "1.0.0.0/8" }] }],
  };
  instance = {
    InstanceId: resourceId,
    Tags: [{ Key: "lease", Value: "cbx_gateway_fixture" }],
    SubnetId: subnetId,
    VpcId: vpcId,
    State: { Name: "running" },
    SecurityGroups: [{ GroupId: groupId }],
    MetadataOptions: { HttpEndpoint: "enabled", State: "applied" },
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
  };
  run.mockReset();
  run.mockImplementation(async (argv) => {
    const operation = argv[2]!;
    await hook?.(operation);
    let value: unknown = {};
    if (operation === "get-caller-identity") {
      value = { Account: account };
    } else if (operation === "describe-subnets") {
      value = {
        Subnets: [{ SubnetId: subnetId, VpcId: vpcId, OwnerId: account, State: "available" }],
      };
    } else if (operation === "describe-vpcs") {
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
    } else if (operation === "describe-route-tables") {
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
    } else if (operation === "describe-internet-gateways") {
      value = {
        InternetGateways: [
          {
            InternetGatewayId: "igw-0123456789abcdef0",
            OwnerId: account,
            Attachments: [{ VpcId: vpcId, State: "available" }],
          },
        ],
      };
    } else if (operation === "describe-security-groups") {
      value = { SecurityGroups: [group] };
    } else if (operation === "describe-instances") {
      value = { Reservations: [{ Instances: [instance] }] };
    } else if (operation === "modify-instance-metadata-options") {
      instance.MetadataOptions = { HttpEndpoint: "disabled", State: "applied" };
    } else if (operation === "terminate-instances") {
      deleted = true;
      instance.State = { Name: "terminated" };
      value = { TerminatingInstances: [{ InstanceId: resourceId }] };
    } else if (operation !== "wait") {
      throw new Error("unexpected mock control-plane request");
    }
    return {
      stdout: operation === "wait" ? "" : JSON.stringify(value),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    };
  });
});
const provision = async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  return await qualifyGatewayAwsGuestResource({
    ...authority(),
    boundary,
    leaseId: "cbx_gateway_fixture",
    resourceId,
    configureMetadata: true,
  });
};
it("qualifies independently, disables metadata before bootstrap and records durable account/resource identity", async () => {
  const receipt = await provision();
  expect(receipt).toMatchObject({
    leaseId: "cbx_gateway_fixture",
    identity: {
      provider: "aws",
      accountId: account,
      resourceId,
      securityGroupId: groupId,
      subnetId,
    },
  });
  expect(run.mock.calls.some(([argv]) => argv[2] === "modify-instance-metadata-options")).toBe(
    true,
  );
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: receipt.leaseId,
      resourceId,
      expected: receipt,
    }),
  ).resolves.toEqual(receipt);
  expect(
    run.mock.calls.every(
      ([argv]) =>
        argv[0] === "aws" && argv.includes("https://" + argv[1] + ".us-east-1.amazonaws.com"),
    ),
  ).toBe(true);
});
it.each([
  "0.0.0.0/0",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.1/32",
  "169.254.169.254/32",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "0.0.0.0/1",
])("rejects private/reserved or overlapping CIDR %s", (cidr) => {
  expect(() => assertPublicAwsCidr(cidr)).toThrow();
});
it.each(["coordinator", "managed", "missing-group", "instance-profile"])(
  "rejects unsupported operator selection before allocation: %s",
  async (reason) => {
    const candidate = structuredClone(config);
    if (reason === "coordinator") {
      candidate.coordinator = "https://example.invalid";
    } else if (reason === "managed") {
      candidate.brokerMode = "managed";
    } else if (reason === "missing-group") {
      candidate.aws.securityGroupId = "";
    } else {
      candidate.aws.instanceProfile = "operator-role";
    }
    await expect(prepareGatewayAwsGuestBoundary(candidate, authority())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  },
);
it.each(["peer", "prefix", "ipv6", "private-egress", "wrong-account"])(
  "rejects unqualified provider API facts: %s",
  async (reason) => {
    if (reason === "wrong-account") {
      group.OwnerId = "999999999999";
    } else {
      const rule: Record<string, unknown> = {
        IpProtocol: "-1",
        IpRanges: [{ CidrIp: "1.0.0.0/8" }],
      };
      if (reason === "peer") {
        rule.UserIdGroupPairs = [{ GroupId: groupId }];
      } else if (reason === "prefix") {
        rule.PrefixListIds = [{ PrefixListId: "pl-01234567" }];
      } else if (reason === "ipv6") {
        rule.Ipv6Ranges = [{ CidrIpv6: "::/0" }];
      } else {
        rule.IpRanges = [{ CidrIp: "0.0.0.0/0" }];
      }
      group.IpPermissionsEgress = [rule];
    }
    await expect(prepareGatewayAwsGuestBoundary(config, authority())).rejects.toThrow();
  },
);
it("rejects instance roles, wrong resource and changed policy on retained access without repair effects", async () => {
  const receipt = await provision();
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  run.mockClear();
  instance.IamInstanceProfile = { Arn: "arn:aws:iam::123456789012:instance-profile/unqualified" };
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: receipt.leaseId,
      resourceId,
      expected: receipt,
    }),
  ).rejects.toThrow();
  expect(run.mock.calls.every(([argv]) => argv[2] !== "modify-instance-metadata-options")).toBe(
    true,
  );
  delete instance.IamInstanceProfile;
  group.IpPermissionsEgress = [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "8.0.0.0/8" }] }];
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: receipt.leaseId,
      resourceId,
      expected: receipt,
    }),
  ).rejects.toThrow("changed");
});
it("rechecks owner authority after awaited readback before any metadata effect", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  run.mockClear();
  hook = async (operation) => {
    if (operation === "describe-instances") {
      current = false;
    }
  };
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).rejects.toThrow("revoked");
  expect(run.mock.calls.every(([argv]) => argv[2] !== "modify-instance-metadata-options")).toBe(
    true,
  );
});
it("trusted cleanup uses durable identity even after the guest network is denied", async () => {
  const receipt = await provision();
  group.IpPermissionsEgress = [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }];
  run.mockClear();
  const accepted = vi.fn();
  await deleteGatewayAwsGuestResource({ ...authority(), receipt, onCleanupAccepted: accepted });
  expect(deleted).toBe(true);
  expect(accepted).toHaveBeenCalledOnce();
  expect(run.mock.calls.every(([argv]) => argv[2] !== "describe-security-groups")).toBe(true);
});

it("never repairs a re-enabled metadata endpoint during retained access", async () => {
  const receipt = await provision();
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  instance.MetadataOptions = { HttpEndpoint: "enabled", State: "applied" };
  run.mockClear();
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: receipt.leaseId,
      resourceId,
      expected: receipt,
      configureMetadata: true,
    }),
  ).rejects.toThrow("metadata endpoint");
  expect(run.mock.calls.every(([argv]) => argv[2] !== "modify-instance-metadata-options")).toBe(
    true,
  );
});
it("rejects a substituted provider resource before any metadata effect", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  instance.InstanceId = "i-11111111111111111";
  run.mockClear();
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).rejects.toThrow("identity");
  expect(run.mock.calls.every(([argv]) => argv[2] !== "modify-instance-metadata-options")).toBe(
    true,
  );
});
it("does not delete through credentials for another recorded account", async () => {
  const receipt = await provision();
  run.mockClear();
  await expect(
    deleteGatewayAwsGuestResource({
      ...authority(),
      receipt: { ...receipt, identity: { ...receipt.identity, accountId: "999999999999" } },
    }),
  ).rejects.toThrow("recorded account");
  expect(deleted).toBe(false);
  expect(run.mock.calls.every(([argv]) => argv[2] !== "terminate-instances")).toBe(true);
});
it("waits for effective metadata readback instead of trusting the modify acknowledgement", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  let reads = 0;
  hook = async (operation) => {
    if (operation === "describe-instances") {
      reads++;
      if (reads === 2) {
        instance.MetadataOptions = { HttpEndpoint: "disabled", State: "pending" };
      } else if (reads >= 3) {
        instance.MetadataOptions = { HttpEndpoint: "disabled", State: "applied" };
      }
    }
  };
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).resolves.toMatchObject({ identity: { resourceId } });
  expect(reads).toBe(3);
});

it("rejects a resource tagged for another lease before any metadata effect", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  instance.Tags = [{ Key: "lease", Value: "another-lease" }];
  run.mockClear();
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).rejects.toThrow("exact Gateway allocation lease");
  expect(run.mock.calls.every(([argv]) => argv[2] !== "modify-instance-metadata-options")).toBe(
    true,
  );
});

it.each(["public-vpc", "peering", "transit", "gateway-endpoint", "ambiguous"])(
  "rejects network topology capable of private access despite numerically public SG egress: %s",
  (reason) => {
    const cidr = reason === "public-vpc" ? "11.0.0.0/16" : "10.0.0.0/16";
    const vpc = {
      VpcId: vpcId,
      OwnerId: account,
      State: "available",
      CidrBlockAssociationSet: [{ CidrBlock: cidr, CidrBlockState: { State: "associated" } }],
      Ipv6CidrBlockAssociationSet: [],
    };
    const privateRoute: Record<string, unknown> = {
      DestinationCidrBlock: "11.0.0.0/8",
      State: "active",
      Origin: "CreateRoute",
    };
    if (reason === "peering") {
      privateRoute.VpcPeeringConnectionId = "pcx-0123456789abcdef0";
    } else if (reason === "transit") {
      privateRoute.TransitGatewayId = "tgw-0123456789abcdef0";
    } else {
      privateRoute.GatewayId = "vpce-0123456789abcdef0";
    }
    const table = {
      RouteTableId: "rtb-0123456789abcdef0",
      OwnerId: account,
      VpcId: vpcId,
      Associations: [{ Main: true }],
      Routes: [
        { DestinationCidrBlock: cidr, GatewayId: "local", State: "active" },
        { DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-0123456789abcdef0", State: "active" },
        ...(reason === "public-vpc" || reason === "ambiguous" ? [] : [privateRoute]),
      ],
    };
    expect(() =>
      assertGuestVpcRoutes(vpc, reason === "ambiguous" ? [table, table] : [table], {
        accountId: account,
        vpcId,
        subnetId,
      }),
    ).toThrow();
  },
);
