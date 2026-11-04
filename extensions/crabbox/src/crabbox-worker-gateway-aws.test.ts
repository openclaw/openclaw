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
  aws: {
    region: "us-east-1",
    securityGroupId: groupId,
    subnetId,
    instanceProfile: "",
    ami: "ami-0123456789abcdef0",
  },
};
let group: Record<string, unknown>,
  instance: Record<string, unknown>,
  current: boolean,
  deleted: boolean;
let volumes: Map<string, Record<string, unknown>>;
let image: Record<string, unknown>;
let hook: ((operation: string) => Promise<void>) | undefined;
const assertCurrent = () => {
  if (!current) {
    throw new Error("lease owner revoked");
  }
};
const authority = () => ({ provider: "aws", assertCurrent, recordResourceReceipt: async () => {} });
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
  image = {
    ImageId: "ami-0123456789abcdef0",
    State: "available",
    RootDeviceType: "ebs",
    RootDeviceName: "/dev/sda1",
    BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { DeleteOnTermination: false } }],
  };
  volumes = new Map([
    [
      "vol-0123456789abcdef0",
      {
        VolumeId: "vol-0123456789abcdef0",
        State: "in-use",
        Tags: [{ Key: "lease", Value: "cbx_gateway_fixture" }],
        Attachments: [{ InstanceId: resourceId, Device: "/dev/sda1", State: "attached" }],
      },
    ],
  ]);
  instance = {
    ImageId: "ami-0123456789abcdef0",
    BlockDeviceMappings: [
      {
        DeviceName: "/dev/sda1",
        Ebs: { VolumeId: "vol-0123456789abcdef0", DeleteOnTermination: true },
      },
    ],
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
    } else if (operation === "describe-images") {
      value = { Images: [image] };
    } else if (operation === "describe-volumes") {
      const id = argv[argv.indexOf("--volume-ids") + 1]!;
      const volume = volumes.get(id);
      if (!volume) {
        return {
          stdout: "",
          stderr: "An error occurred (InvalidVolume.NotFound) when calling DescribeVolumes",
          code: 255,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      value = { Volumes: [volume] };
    } else if (operation === "delete-volume") {
      volumes.delete(argv[argv.indexOf("--volume-id") + 1]!);
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
      if (Array.isArray(instance.BlockDeviceMappings)) {
        for (const row of instance.BlockDeviceMappings) {
          const mapping = row.Ebs;
          const volume = volumes.get(mapping.VolumeId);
          if (mapping.DeleteOnTermination) {
            volumes.delete(mapping.VolumeId);
          } else if (volume) {
            volume.Attachments = [];
            volume.State = "available";
          }
        }
      }
      instance.State = { Name: "terminated" };
      value = { TerminatingInstances: [{ InstanceId: resourceId }] };
    } else if (operation !== "wait") {
      throw new Error("unexpected mock control-plane request");
    }
    return {
      stdout: operation === "wait" || operation === "delete-volume" ? "" : JSON.stringify(value),
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

it("rejects a nondeleting AMI-derived data device before any allocation or metadata effect", async () => {
  image.BlockDeviceMappings = [
    { DeviceName: "/dev/sda1", Ebs: { DeleteOnTermination: false } },
    { DeviceName: "/dev/sdf", Ebs: { DeleteOnTermination: false } },
  ];
  await expect(prepareGatewayAwsGuestBoundary(config, authority())).rejects.toThrow(
    "before allocation",
  );
  expect(
    run.mock.calls.every(
      ([argv]) =>
        !["modify-instance-metadata-options", "terminate-instances", "delete-volume"].includes(
          argv[2]!,
        ),
    ),
  ).toBe(true);
});
it("requires explicit AMI before provisioning rather than trusting unresolved image defaults", async () => {
  await expect(
    prepareGatewayAwsGuestBoundary({ ...config, aws: { ...config.aws, ami: "" } }, authority()),
  ).rejects.toThrow("AMI");
  expect(run).not.toHaveBeenCalled();
});
function addDataVolume(autodelete: boolean) {
  const volumeId = "vol-11111111111111111";
  instance.BlockDeviceMappings = [
    {
      DeviceName: "/dev/sda1",
      Ebs: { VolumeId: "vol-0123456789abcdef0", DeleteOnTermination: true },
    },
    { DeviceName: "/dev/sdf", Ebs: { VolumeId: volumeId, DeleteOnTermination: autodelete } },
  ];
  volumes.set(volumeId, {
    VolumeId: volumeId,
    State: "in-use",
    Tags: [{ Key: "lease", Value: "cbx_gateway_fixture" }],
    Attachments: [{ InstanceId: resourceId, Device: "/dev/sdf", State: "attached" }],
  });
  return volumeId;
}
it("persists the exact owned data volume before rejecting actual nondelete mapping; restart cleanup deletes and observes absence", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  const volumeId = addDataVolume(false);
  const record = vi.fn<
    (receipt: import("openclaw/plugin-sdk/plugin-entry").WorkerResourceReceipt) => Promise<void>
  >(async () => {});
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      recordResourceReceipt: record,
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).rejects.toThrow("not delete-on-termination");
  expect(record).toHaveBeenCalledOnce();
  expect(run.mock.calls.every(([argv]) => argv[2] !== "modify-instance-metadata-options")).toBe(
    true,
  );
  const receipt = structuredClone(record.mock.calls[0]![0]);
  expect(receipt.identity.launchVolumes).toContain(volumeId);
  run.mockClear();
  await deleteGatewayAwsGuestResource({ ...authority(), receipt });
  expect(volumes.size).toBe(0);
  expect(
    run.mock.calls.some(([argv]) => argv[2] === "delete-volume" && argv.includes(volumeId)),
  ).toBe(true);
  // A restart retries durable custody after instance termination/volume absence.
  await expect(deleteGatewayAwsGuestResource({ ...authority(), receipt })).resolves.toBeUndefined();
});
it("accepts all-delete actual mappings and confirms every volume absent before cleanup success", async () => {
  addDataVolume(true);
  const receipt = await provision();
  run.mockClear();
  await deleteGatewayAwsGuestResource({ ...authority(), receipt });
  expect(volumes.size).toBe(0);
  expect(run.mock.calls.filter(([argv]) => argv[2] === "describe-volumes")).toHaveLength(4);
  expect(run.mock.calls.some(([argv]) => argv[2] === "delete-volume")).toBe(false);
});
it.each(["foreign-tag", "foreign-attachment", "substituted-id", "permission"])(
  "preserves cleanup ownership without deleting a borrowed/unknown disk: %s",
  async (reason) => {
    const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
    const volumeId = addDataVolume(false);
    let receipt: import("openclaw/plugin-sdk/plugin-entry").WorkerResourceReceipt | undefined;
    await expect(
      qualifyGatewayAwsGuestResource({
        ...authority(),
        recordResourceReceipt: async (value) => {
          receipt = value;
        },
        boundary,
        leaseId: "cbx_gateway_fixture",
        resourceId,
        configureMetadata: true,
      }),
    ).rejects.toThrow("not delete-on-termination");
    if (!receipt) {
      throw new Error("test requires persisted custody");
    }
    const volume = volumes.get(volumeId)!;
    if (reason === "foreign-tag") {
      volume.Tags = [{ Key: "lease", Value: "other-lease" }];
    } else if (reason === "foreign-attachment") {
      volume.Attachments = [
        { InstanceId: "i-11111111111111111", Device: "/dev/sdf", State: "attached" },
      ];
    } else if (reason === "substituted-id") {
      instance.BlockDeviceMappings = [
        {
          DeviceName: "/dev/sdf",
          Ebs: { VolumeId: "vol-22222222222222222", DeleteOnTermination: false },
        },
      ];
    } else {
      hook = async (operation) => {
        if (operation === "describe-volumes") {
          throw new Error("permission denied");
        }
      };
    }
    run.mockClear();
    await expect(deleteGatewayAwsGuestResource({ ...authority(), receipt })).rejects.toThrow();
    expect(
      run.mock.calls.every(
        ([argv]) => argv[2] !== "terminate-instances" && argv[2] !== "delete-volume",
      ),
    ).toBe(true);
    expect(volumes.has(volumeId)).toBe(true);
  },
);
it("unknown volume deletion outcome does not resolve cleanup and retry consumes only recorded IDs", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  const volumeId = addDataVolume(false);
  let receipt: import("openclaw/plugin-sdk/plugin-entry").WorkerResourceReceipt | undefined;
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      recordResourceReceipt: async (value) => {
        receipt = value;
      },
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).rejects.toThrow();
  if (!receipt) {
    throw new Error("missing test custody");
  }
  hook = async (operation) => {
    if (operation === "delete-volume") {
      throw new Error("uncertain delete");
    }
  };
  await expect(deleteGatewayAwsGuestResource({ ...authority(), receipt })).rejects.toThrow(
    "uncertain delete",
  );
  expect(deleted).toBe(true);
  expect(volumes.has(volumeId)).toBe(true);
  hook = undefined;
  await expect(deleteGatewayAwsGuestResource({ ...authority(), receipt })).resolves.toBeUndefined();
  expect(volumes.has(volumeId)).toBe(false);
});

it("keeps cleanup unresolved when deletion succeeded but the required absence observation is denied", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  const volumeId = addDataVolume(false);
  let receipt: import("openclaw/plugin-sdk/plugin-entry").WorkerResourceReceipt | undefined;
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      recordResourceReceipt: async (value) => {
        receipt = value;
      },
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).rejects.toThrow();
  if (!receipt) {
    throw new Error("missing custody");
  }
  hook = async (operation) => {
    if (operation === "describe-volumes" && deleted && !volumes.has(volumeId)) {
      throw new Error("absence permission unavailable");
    }
  };
  await expect(deleteGatewayAwsGuestResource({ ...authority(), receipt })).rejects.toThrow(
    "absence permission unavailable",
  );
  expect(volumes.has(volumeId)).toBe(false);
  hook = undefined;
  await expect(deleteGatewayAwsGuestResource({ ...authority(), receipt })).resolves.toBeUndefined();
});

it("settles partial identity before foreign-volume qualification but never permits deleting that disk", async () => {
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  const id = addDataVolume(false);
  volumes.get(id)!.Tags = [{ Key: "lease", Value: "foreign-lease" }];
  let receipt: import("openclaw/plugin-sdk/plugin-entry").WorkerResourceReceipt | undefined;
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      recordResourceReceipt: async (value) => {
        receipt = structuredClone(value);
      },
      boundary,
      leaseId: "cbx_gateway_fixture",
      resourceId,
      configureMetadata: true,
    }),
  ).rejects.toThrow("ownership");
  if (!receipt) {
    throw new Error("partial custody must precede foreign qualification");
  }
  expect(receipt.identity.custodyStage).toBe("launch-observed");
  run.mockClear();
  await expect(deleteGatewayAwsGuestResource({ ...authority(), receipt })).rejects.toThrow(
    "ownership",
  );
  expect(
    run.mock.calls.every(([argv]) => !["terminate-instances", "delete-volume"].includes(argv[2]!)),
  ).toBe(true);
});
it("cleanup-observed partial custody cannot grant guest access or replace existing identity", async () => {
  const receipt = await provision();
  const boundary = await prepareGatewayAwsGuestBoundary(config, authority());
  const record = vi.fn(async () => {});
  await expect(
    qualifyGatewayAwsGuestResource({
      ...authority(),
      recordResourceReceipt: record,
      boundary,
      leaseId: receipt.leaseId,
      resourceId,
      expected: { ...receipt, identity: { ...receipt.identity, custodyStage: "cleanup-observed" } },
    }),
  ).rejects.toThrow("does not authorize");
  expect(record).not.toHaveBeenCalled();
});
