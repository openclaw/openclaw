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

export type GatewayAwsAuthority = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
};
export type GatewayAwsBoundary = {
  region: string;
  accountId: string;
  groupId: string;
  subnetId: string;
  vpcId: string;
  rulesDigest: string;
};
class GatewayAwsResourceAbsentError extends Error {}
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
  if (operation === "wait" && result.stdout.trim() === "") {
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
  fields: { region: string; groupId: string; subnetId: string },
): Promise<GatewayAwsBoundary> {
  const caller = await awsJson(params, fields.region, "sts", "get-caller-identity");
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
  return await readBoundary(params, { region, groupId, subnetId });
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
/** Core's held allocation authority binds this readback to the lease and owner epoch. */
export async function qualifyGatewayAwsGuestResource(
  params: GatewayAwsAuthority & {
    boundary: GatewayAwsBoundary;
    leaseId: string;
    resourceId: string;
    expected?: WorkerResourceReceipt;
    configureMetadata?: boolean;
  },
): Promise<WorkerResourceReceipt> {
  const resourceId = requiredId(params.resourceId, /^i-[a-f0-9]{8,17}$/u, "AWS instance identity");
  let instance = await readInstance(params, params.boundary, resourceId);
  const leaseTags = Array.isArray(instance.Tags)
    ? instance.Tags.filter((tag) => requireAwsRecord(tag, "instance tag").Key === "lease")
    : [];
  if (
    leaseTags.length !== 1 ||
    requireAwsRecord(leaseTags[0], "lease tag").Value !== params.leaseId
  ) {
    throw new WorkerProviderError(
      "AWS instance is not tagged for the exact Gateway allocation lease",
    );
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
  const receipt: WorkerResourceReceipt = {
    version: 1,
    leaseId: params.leaseId,
    identity: {
      gatewayOwner: RECEIPT_OWNER,
      provider: "aws",
      resourceId,
      accountId: live.accountId,
      region: live.region,
      securityGroupId: live.groupId,
      subnetId: live.subnetId,
      vpcId: live.vpcId,
      rulesDigest: live.rulesDigest,
    },
  };
  if (params.expected && !isDeepStrictEqual(receipt, params.expected)) {
    throw new WorkerProviderError("Gateway-owned AWS guest resource receipt changed");
  }
  params.assertCurrent();
  return receipt;
}

/** Cleanup uses only the persisted account/resource identity, never guest network permission. */
export async function deleteGatewayAwsGuestResource(
  params: GatewayAwsAuthority & { receipt: WorkerResourceReceipt; onCleanupAccepted?: () => void },
): Promise<void> {
  const receipt = params.receipt;
  if (!isGatewayAwsGuestReceipt(receipt) || receipt.identity.provider !== "aws") {
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
  try {
    const existing = await awsJson(params, region, "ec2", "describe-instances", [
      "--instance-ids",
      resourceId,
    ]);
    const instance = onlyAwsRecord(
      onlyAwsRecord(existing.Reservations, "cleanup reservation").Instances,
      "cleanup instance",
    );
    if (instance.InstanceId !== resourceId) {
      throw new WorkerProviderError("AWS cleanup resource identity changed");
    }
    if (requireAwsRecord(instance.State, "cleanup state").Name === "terminated") {
      return;
    }
  } catch (error) {
    if (error instanceof GatewayAwsResourceAbsentError) {
      return;
    }
    throw error;
  }
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
  params.assertCurrent();
}
