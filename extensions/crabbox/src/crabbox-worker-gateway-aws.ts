import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { WorkerProviderError, type WorkerResourceReceipt } from "openclaw/plugin-sdk/plugin-entry";
import { runCrabboxProcess } from "./crabbox-process.js";
import {
  assertGuestSecurityGroup,
  assertGuestVpcRoutes,
  onlyAwsRecord,
  requireAwsRecord,
} from "./crabbox-worker-gateway-aws-policy.js";
import {
  assertDisposableAwsImage,
  launchVolumeMappings,
  assertOwnedLaunchVolume,
  receiptVolumes,
} from "./crabbox-worker-gateway-aws-volumes.js";

export type GatewayAwsAuthority = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
};
export type GatewayAwsBoundary = {
  imageId: string;
  region: string;
  accountId: string;
  groupId: string;
  subnetId: string;
  vpcId: string;
  rulesDigest: string;
};
class GatewayAwsResourceAbsentError extends Error {}
class GatewayAwsVolumeAbsentError extends Error {}
const RECEIPT_OWNER = "openclaw-gateway-aws-network-v1";
export function isGatewayAwsGuestReceipt(receipt: WorkerResourceReceipt | undefined): boolean {
  return receipt?.identity.gatewayOwner === RECEIPT_OWNER;
}
async function awsJson(
  params: GatewayAwsAuthority,
  region: string,
  service: "sts" | "ec2",
  operation: string,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const result = await runCrabboxProcess(
    [
      "aws",
      service,
      operation,
      "--region",
      region,
      "--endpoint-url",
      "https://" + service + "." + region + ".amazonaws.com",
      ...args,
      "--output",
      "json",
    ],
    {
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024,
      killProcessTree: true,
      signal: params.signal,
      env: { ...process.env, ...params.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
    },
  );
  params.assertCurrent();
  params.signal?.throwIfAborted();
  if (result.code !== 0 || result.termination !== "exit") {
    if (
      service === "ec2" &&
      operation === "describe-volumes" &&
      /\(InvalidVolume.NotFound\)/u.test(result.stderr)
    ) {
      throw new GatewayAwsVolumeAbsentError("Recorded launch volume is absent");
    }
    if (
      service === "ec2" &&
      operation === "describe-instances" &&
      /\(InvalidInstanceID.NotFound\)/u.test(result.stderr)
    ) {
      throw new GatewayAwsResourceAbsentError("Bound AWS guest resource is absent");
    }
    throw new WorkerProviderError(
      "Gateway-only AWS guest qualification requires working AWS CLI credentials on the Gateway (" +
        operation +
        ")",
    );
  }
  if ((operation === "wait" || operation === "delete-volume") && result.stdout.trim() === "") {
    return {};
  }
  try {
    return requireAwsRecord(JSON.parse(result.stdout), operation);
  } catch {
    throw new WorkerProviderError(
      "AWS guest control plane returned invalid " + operation + " JSON",
    );
  }
}
function requiredId(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WorkerProviderError(
      "Gateway-only AWS guest mode requires an explicit valid " + label,
    );
  }
  return value;
}
async function readBoundary(
  params: GatewayAwsAuthority,
  fields: { region: string; groupId: string; subnetId: string; imageId: string },
): Promise<GatewayAwsBoundary> {
  const caller = await awsJson(params, fields.region, "sts", "get-caller-identity");
  const image = await awsJson(params, fields.region, "ec2", "describe-images", [
    "--image-ids",
    fields.imageId,
  ]);
  assertDisposableAwsImage(image.Images, fields.imageId);
  const accountId = requiredId(caller.Account, /^\d{12}$/u, "AWS account");
  const subnets = await awsJson(params, fields.region, "ec2", "describe-subnets", [
    "--subnet-ids",
    fields.subnetId,
  ]);
  const subnet = onlyAwsRecord(subnets.Subnets, "subnet");
  if (
    subnet.SubnetId !== fields.subnetId ||
    subnet.OwnerId !== accountId ||
    subnet.State !== "available"
  ) {
    throw new WorkerProviderError("AWS guest subnet ownership is unqualified");
  }
  const vpcId = requiredId(subnet.VpcId, /^vpc-[a-f0-9]{8,17}$/u, "AWS VPC");
  const vpcs = await awsJson(params, fields.region, "ec2", "describe-vpcs", ["--vpc-ids", vpcId]);
  const routeTables = await awsJson(params, fields.region, "ec2", "describe-route-tables", [
    "--filters",
    "Name=vpc-id,Values=" + vpcId,
  ]);
  const topology = assertGuestVpcRoutes(onlyAwsRecord(vpcs.Vpcs, "VPC"), routeTables.RouteTables, {
    accountId,
    vpcId,
    subnetId: fields.subnetId,
  });
  const gateways = await awsJson(params, fields.region, "ec2", "describe-internet-gateways", [
    "--internet-gateway-ids",
    topology.gatewayId,
  ]);
  const gateway = onlyAwsRecord(gateways.InternetGateways, "internet gateway");
  const attachment = onlyAwsRecord(gateway.Attachments, "internet gateway attachment");
  if (
    gateway.InternetGatewayId !== topology.gatewayId ||
    gateway.OwnerId !== accountId ||
    attachment.VpcId !== vpcId ||
    attachment.State !== "available"
  ) {
    throw new WorkerProviderError("AWS guest internet gateway ownership or attachment changed");
  }
  const groups = await awsJson(params, fields.region, "ec2", "describe-security-groups", [
    "--group-ids",
    fields.groupId,
  ]);
  const group = onlyAwsRecord(groups.SecurityGroups, "security group");
  const facts = assertGuestSecurityGroup(group, {
    accountId,
    groupId: fields.groupId,
    subnetVpcId: vpcId,
  });
  return {
    ...fields,
    accountId,
    vpcId,
    rulesDigest: createHash("sha256")
      .update(JSON.stringify([facts, topology.facts, topology.gatewayId]))
      .digest("hex"),
  };
}
/** Existing Crabbox config selects the boundary; only independent AWS API facts qualify it. */
export async function prepareGatewayAwsGuestBoundary(
  config: unknown,
  params: GatewayAwsAuthority & { provider: string },
): Promise<GatewayAwsBoundary> {
  const view = requireAwsRecord(config, "Crabbox config");
  if (
    view.coordinator ||
    view.brokerMode !== "direct" ||
    params.provider !== "aws" ||
    view.provider !== "aws"
  ) {
    throw new WorkerProviderError(
      "Gateway-only guest mode initially supports direct AWS allocation, not coordinator routes",
    );
  }
  const aws = requireAwsRecord(view.aws, "AWS config");
  if (aws.instanceProfile !== "") {
    throw new WorkerProviderError("AWS guest instances must not receive an instance profile");
  }
  const region = requiredId(aws.region, /^[a-z]{2}-[a-z]+-\d$/u, "commercial AWS region");
  const groupId = requiredId(aws.securityGroupId, /^sg-[a-f0-9]{8,17}$/u, "AWS security group");
  const subnetId = requiredId(aws.subnetId, /^subnet-[a-f0-9]{8,17}$/u, "AWS subnet");
  const imageId = requiredId(aws.ami, /^ami-[a-f0-9]{8,17}$/u, "explicit trusted AWS AMI");
  return await readBoundary(params, { region, groupId, subnetId, imageId });
}
function assertInstance(
  value: unknown,
  resourceId: string,
  boundary: GatewayAwsBoundary,
): Record<string, unknown> {
  const instance = requireAwsRecord(value, "instance");
  if (
    instance.InstanceId !== resourceId ||
    instance.SubnetId !== boundary.subnetId ||
    instance.VpcId !== boundary.vpcId ||
    instance.IamInstanceProfile !== undefined
  ) {
    throw new WorkerProviderError(
      "AWS guest resource identity or instance-profile boundary changed",
    );
  }
  const groups = onlyAwsRecord(instance.SecurityGroups, "instance security group");
  if (groups.GroupId !== boundary.groupId) {
    throw new WorkerProviderError("AWS guest instance uses a different security group");
  }
  const nic = onlyAwsRecord(instance.NetworkInterfaces, "network interface");
  if (
    nic.OwnerId !== boundary.accountId ||
    nic.SubnetId !== boundary.subnetId ||
    nic.VpcId !== boundary.vpcId ||
    nic.SourceDestCheck !== true ||
    !Array.isArray(nic.Ipv6Addresses) ||
    nic.Ipv6Addresses.length
  ) {
    throw new WorkerProviderError(
      "AWS guest interface identity, routing or IPv6 state is unqualified",
    );
  }
  if (onlyAwsRecord(nic.Groups, "interface security group").GroupId !== boundary.groupId) {
    throw new WorkerProviderError("AWS guest interface security group changed");
  }
  return instance;
}
async function readInstance(
  params: GatewayAwsAuthority,
  boundary: GatewayAwsBoundary,
  resourceId: string,
): Promise<Record<string, unknown>> {
  const result = await awsJson(params, boundary.region, "ec2", "describe-instances", [
    "--instance-ids",
    resourceId,
  ]);
  return assertInstance(
    onlyAwsRecord(onlyAwsRecord(result.Reservations, "reservation").Instances, "instance"),
    resourceId,
    boundary,
  );
}
/** Observation is custody, not guest qualification. It is bounded and never scans tags. */
export async function captureGatewayAwsGuestCustody(
  params: GatewayAwsAuthority & {
    region: string;
    leaseId: string;
    resourceId: string;
    boundary?: GatewayAwsBoundary;
  },
) {
  const resourceId = requiredId(params.resourceId, /^i-[a-f0-9]{8,17}$/u, "AWS instance identity");
  const region = requiredId(params.region, /^[a-z]{2}-[a-z]+-\d$/u, "AWS region");
  const account = await awsJson(params, region, "sts", "get-caller-identity");
  const accountId = requiredId(account.Account, /^\d{12}$/u, "AWS account");
  if (params.boundary && accountId !== params.boundary.accountId) {
    throw new WorkerProviderError("AWS custody account changed");
  }
  const result = await awsJson(params, region, "ec2", "describe-instances", [
    "--instance-ids",
    resourceId,
  ]);
  const instance = onlyAwsRecord(
    onlyAwsRecord(result.Reservations, "reservation").Instances,
    "instance",
  );
  const tags = Array.isArray(instance.Tags)
    ? instance.Tags.filter((tag) => requireAwsRecord(tag, "instance tag").Key === "lease")
    : [];
  if (
    instance.InstanceId !== resourceId ||
    tags.length !== 1 ||
    requireAwsRecord(tags[0], "lease tag").Value !== params.leaseId
  ) {
    throw new WorkerProviderError(
      "AWS instance identity does not match the exact Gateway allocation lease",
    );
  }
  const imageId = requiredId(instance.ImageId, /^ami-[a-f0-9]{8,17}$/u, "observed AMI identity");
  const volumes = launchVolumeMappings(instance);
  const receipt: WorkerResourceReceipt = {
    version: 1,
    leaseId: params.leaseId,
    identity: {
      gatewayOwner: RECEIPT_OWNER,
      provider: "aws",
      custodyStage: params.boundary ? "launch-observed" : "cleanup-observed",
      resourceId,
      accountId,
      region,
      imageId,
      launchVolumes: JSON.stringify(volumes),
      ...(params.boundary
        ? {
            securityGroupId: params.boundary.groupId,
            subnetId: params.boundary.subnetId,
            vpcId: params.boundary.vpcId,
            rulesDigest: params.boundary.rulesDigest,
          }
        : {}),
    },
  };
  return { receipt, instance, volumes };
}

/** Core's held allocation authority binds this readback to the lease and owner epoch. */
export async function qualifyGatewayAwsGuestResource(
  params: GatewayAwsAuthority & {
    boundary: GatewayAwsBoundary;
    leaseId: string;
    resourceId: string;
    expected?: WorkerResourceReceipt;
    recordResourceReceipt?: (receipt: WorkerResourceReceipt) => Promise<void>;
    configureMetadata?: boolean;
  },
): Promise<WorkerResourceReceipt> {
  const resourceId = requiredId(params.resourceId, /^i-[a-f0-9]{8,17}$/u, "AWS instance identity");
  if (params.expected && params.expected.identity.custodyStage !== "launch-observed") {
    throw new WorkerProviderError("Partial cleanup custody does not authorize guest access");
  }
  const custody = await captureGatewayAwsGuestCustody({
    ...params,
    region: params.boundary.region,
  });
  const { receipt, volumes } = custody;
  let instance = custody.instance;
  if (params.expected) {
    if (!isDeepStrictEqual(receipt, params.expected)) {
      throw new WorkerProviderError("Gateway-owned AWS guest resource receipt changed");
    }
  } else {
    if (!params.configureMetadata || !params.recordResourceReceipt) {
      throw new WorkerProviderError(
        "AWS guest launch volumes require durable custody before qualification",
      );
    }
    // Immutable partial identity is settled before ANY per-volume/network read.
    // It never attests qualification; every guest access still performs live checks.
    await params.recordResourceReceipt(receipt);
    params.assertCurrent();
  }
  for (const volume of volumes) {
    const observed = await awsJson(params, params.boundary.region, "ec2", "describe-volumes", [
      "--volume-ids",
      volume.volumeId,
    ]);
    assertOwnedLaunchVolume(observed.Volumes, volume, params.leaseId, resourceId, true);
  }
  if (instance.ImageId !== params.boundary.imageId) {
    throw new WorkerProviderError("AWS guest observed AMI changed");
  }
  assertInstance(instance, resourceId, params.boundary);
  // Qualification failures after custody settlement retain exact disks for trusted
  // teardown. Never silently repair a non-disposable launch into guest admission.
  if (!Array.isArray(instance.BlockDeviceMappings)) {
    throw new WorkerProviderError("AWS guest block-device mappings missing");
  }
  for (const item of instance.BlockDeviceMappings) {
    if (
      requireAwsRecord(requireAwsRecord(item, "device").Ebs, "EBS mapping").DeleteOnTermination !==
      true
    ) {
      throw new WorkerProviderError("AWS guest actual launch volume is not delete-on-termination");
    }
  }
  let metadata = requireAwsRecord(instance.MetadataOptions, "metadata options");
  if (metadata.HttpEndpoint !== "disabled" && params.configureMetadata && !params.expected) {
    // Trusted allocation bootstrap has not admitted any guest or delivered node credentials.
    // No network/credential guard is relaxed for cleanup or a retained guest access.
    await awsJson(params, params.boundary.region, "ec2", "modify-instance-metadata-options", [
      "--instance-id",
      resourceId,
      "--http-endpoint",
      "disabled",
    ]);
    const settleBy = performance.now() + 60_000;
    do {
      instance = await readInstance(params, params.boundary, resourceId);
      metadata = requireAwsRecord(instance.MetadataOptions, "metadata options");
      if (metadata.State === "applied") {
        break;
      }
      if (metadata.State !== "pending" || performance.now() >= settleBy) {
        break;
      }
      await delay(1000, undefined, { signal: params.signal });
      params.assertCurrent();
    } while (metadata.State === "pending" && performance.now() < settleBy);
  }
  if (metadata.HttpEndpoint !== "disabled" || metadata.State !== "applied") {
    throw new WorkerProviderError("AWS guest metadata endpoint is not independently disabled");
  }
  const live = await readBoundary(params, params.boundary);
  if (!isDeepStrictEqual(live, params.boundary)) {
    throw new WorkerProviderError("AWS guest network boundary or account changed");
  }
  params.assertCurrent();
  return receipt;
}

/** Cleanup uses only the persisted account/resource identity, never guest network permission. */
export async function deleteGatewayAwsGuestResource(
  params: GatewayAwsAuthority & { receipt: WorkerResourceReceipt; onCleanupAccepted?: () => void },
): Promise<void> {
  const receipt = params.receipt;
  if (
    !isGatewayAwsGuestReceipt(receipt) ||
    receipt.identity.provider !== "aws" ||
    !["launch-observed", "cleanup-observed"].includes(receipt.identity.custodyStage ?? "")
  ) {
    throw new WorkerProviderError("Gateway AWS cleanup receipt is unavailable");
  }
  const region = requiredId(receipt.identity.region, /^[a-z]{2}-[a-z]+-\d$/u, "cleanup region");
  const resourceId = requiredId(
    receipt.identity.resourceId,
    /^i-[a-f0-9]{8,17}$/u,
    "cleanup resource",
  );
  const account = await awsJson(params, region, "sts", "get-caller-identity");
  if (account.Account !== receipt.identity.accountId) {
    throw new WorkerProviderError("AWS cleanup credentials do not belong to the recorded account");
  }
  const volumes = receiptVolumes(receipt.identity.launchVolumes);
  let terminated: boolean;
  try {
    const result = await awsJson(params, region, "ec2", "describe-instances", [
      "--instance-ids",
      resourceId,
    ]);
    const instance = onlyAwsRecord(
      onlyAwsRecord(result.Reservations, "cleanup reservation").Instances,
      "cleanup instance",
    );
    if (instance.InstanceId !== resourceId) {
      throw new WorkerProviderError("AWS cleanup resource identity changed");
    }
    terminated = requireAwsRecord(instance.State, "cleanup state").Name === "terminated";
    if (!terminated) {
      if (!isDeepStrictEqual(launchVolumeMappings(instance), volumes)) {
        throw new WorkerProviderError("AWS cleanup instance volume set changed; custody retained");
      }
      for (const volume of volumes) {
        const observed = await awsJson(params, region, "ec2", "describe-volumes", [
          "--volume-ids",
          volume.volumeId,
        ]);
        assertOwnedLaunchVolume(observed.Volumes, volume, receipt.leaseId, resourceId, true);
      }
    }
  } catch (error) {
    if (error instanceof GatewayAwsResourceAbsentError) {
      terminated = true;
    } else {
      throw error;
    }
  }
  if (!terminated) {
    const accepted = await awsJson(params, region, "ec2", "terminate-instances", [
      "--instance-ids",
      resourceId,
    ]);
    if (onlyAwsRecord(accepted.TerminatingInstances, "termination").InstanceId !== resourceId) {
      throw new WorkerProviderError("AWS did not acknowledge the bound guest resource termination");
    }
    params.onCleanupAccepted?.();
    await awsJson(params, region, "ec2", "wait", [
      "instance-terminated",
      "--instance-ids",
      resourceId,
    ]);
  }
  // Original launch disks remain custody after instance absence. Delete only an
  // exact recorded, lease-tagged, independently detached volume; verify absence.
  for (const volume of volumes) {
    try {
      const observed = await awsJson(params, region, "ec2", "describe-volumes", [
        "--volume-ids",
        volume.volumeId,
      ]);
      assertOwnedLaunchVolume(observed.Volumes, volume, receipt.leaseId, resourceId, false);
      await awsJson(params, region, "ec2", "delete-volume", ["--volume-id", volume.volumeId]);
      try {
        await awsJson(params, region, "ec2", "describe-volumes", ["--volume-ids", volume.volumeId]);
      } catch (error) {
        if (error instanceof GatewayAwsVolumeAbsentError) {
          continue;
        }
        throw error;
      }
      throw new WorkerProviderError(
        "AWS launch volume deletion unconfirmed; cleanup remains owned",
      );
    } catch (error) {
      if (error instanceof GatewayAwsVolumeAbsentError) {
        continue;
      }
      throw error;
    }
  }

  params.assertCurrent();
}
