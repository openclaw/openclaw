import { isDeepStrictEqual } from "node:util";
import { isRecord, readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type GuestNetworkPolicy = {
  version: 1;
  policyId: string;
  policyRevision: string;
  policyDigest: string;
  bootstrapMode?: "ssh-public-key-v1";
};
export type GuestNetworkExpectation = {
  allocationRoute: "direct" | "managed-coordinator";
  policy: GuestNetworkPolicy;
};
export type GuestNetworkReceipt = GuestNetworkPolicy & {
  leaseId: string;
  provider: "aws";
  resourceId: string;
  boundaryId: string;
  facts: Record<string, string>;
};
export type GuestNetworkBinding = {
  expected: GuestNetworkExpectation;
  acquisition?: GuestNetworkReceipt;
};
const platformExceptions =
  "dns,dhcp,time-sync,vpc-router,windows-license-activation,ecs-task-metadata";
function invalid(message: string): never {
  throw new Error("Crabbox guest-network-v1: " + message);
}
function text(value: unknown, name: string): string {
  const result = readNonBlankString(value);
  if (!result || result.length > 1024) {
    return invalid("missing/invalid " + name);
  }
  return result;
}
export function readGuestNetworkPolicy(value: unknown): GuestNetworkPolicy {
  if (!isRecord(value) || value.version !== 1) {
    return invalid("unsupported policy version");
  }
  const policyId = text(value.policyId, "policy ID"),
    policyRevision = text(value.policyRevision, "policy revision"),
    policyDigest = text(value.policyDigest, "policy digest");
  if (!/^[a-f0-9]{64}$/u.test(policyDigest)) {
    return invalid("invalid policy digest");
  }
  if (value.bootstrapMode !== undefined && value.bootstrapMode !== "ssh-public-key-v1") {
    return invalid("unknown bootstrap mode");
  }
  return {
    version: 1,
    policyId,
    policyRevision,
    policyDigest,
    ...(value.bootstrapMode === "ssh-public-key-v1" ? { bootstrapMode: value.bootstrapMode } : {}),
  };
}
export function readGuestNetworkExpectation(config: unknown): GuestNetworkExpectation {
  if (!isRecord(config) || config.provider !== "aws" || !isRecord(config.guestNetworkCapability)) {
    return invalid("missing configured AWS enforcement capability");
  }
  const capability = config.guestNetworkCapability;
  if (
    capability.version !== 1 ||
    capability.state !== "implemented" ||
    (capability.allocationRoute !== "direct" &&
      capability.allocationRoute !== "managed-coordinator")
  ) {
    return invalid("route is not qualified by the current enforcing coordinator");
  }
  const policy = readGuestNetworkPolicy(config.guestNetworkPolicy);
  if (
    (capability.allocationRoute === "managed-coordinator") !==
    (policy.bootstrapMode === "ssh-public-key-v1")
  ) {
    return invalid("policy/bootstrap route mismatch");
  }
  return { allocationRoute: capability.allocationRoute, policy };
}
export function readGuestNetworkReceipt(
  value: unknown,
  expected: GuestNetworkExpectation,
  binding: { leaseId: string; provider: string; resourceId?: string },
): GuestNetworkReceipt {
  if (!isRecord(value)) {
    return invalid("missing receipt");
  }
  const policy = readGuestNetworkPolicy(value);
  if (!isDeepStrictEqual(policy, expected.policy)) {
    return invalid("observed policy does not match expected policy");
  }
  if (
    value.leaseId !== binding.leaseId ||
    value.provider !== binding.provider ||
    value.provider !== "aws"
  ) {
    return invalid("foreign lease/provider receipt");
  }
  const resourceId = text(value.resourceId, "resource identity"),
    boundaryId = text(value.boundaryId, "network boundary");
  if (
    !/^i-[a-zA-Z0-9]+$/u.test(resourceId) ||
    !/^sg-[a-zA-Z0-9]+$/u.test(boundaryId) ||
    (binding.resourceId !== undefined && resourceId !== binding.resourceId)
  ) {
    return invalid("foreign resource/boundary identity");
  }
  if (!isRecord(value.facts)) {
    return invalid("missing observed enforcement facts");
  }
  const required: Record<string, string> = {
    instanceProfile: "none",
    ipv6: "absent",
    egress: "operator-public-ipv4-tcp-allowlist",
    amazonProvidedDNS: "aws-resolver-exception",
    platformExceptionsPolicy: "aws-platform-services-v1",
    awsPlatformExceptions: platformExceptions,
    imds: policy.bootstrapMode ? "roleless-v2" : "disabled",
  };
  const identifiers: Record<string, string> = {
    subnetId: "subnet-",
    vpcId: "vpc-",
    networkInterfaceId: "eni-",
  };
  const facts: Record<string, string> = {};
  for (const [key, wanted] of Object.entries(required)) {
    if (value.facts[key] !== wanted) {
      return invalid("unqualified enforcement fact " + key);
    }
    facts[key] = wanted;
  }
  for (const [key, prefix] of Object.entries(identifiers)) {
    const observed = text(value.facts[key], key);
    if (!observed.startsWith(prefix)) {
      return invalid("invalid " + key);
    }
    facts[key] = observed;
  }
  if (policy.bootstrapMode) {
    if (value.facts.bootstrapMode !== policy.bootstrapMode) {
      return invalid("bootstrap mode mismatch");
    }
    const sha = text(value.facts.bootstrapSha256, "bootstrap digest"),
      hostKey = text(value.facts.sshHostKey, "SSH host key");
    if (!/^[a-f0-9]{64}$/u.test(sha) || !/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(hostKey)) {
      return invalid("invalid public bootstrap identity");
    }
    facts.bootstrapMode = policy.bootstrapMode;
    facts.bootstrapSha256 = sha;
    facts.sshHostKey = hostKey;
  }
  if (Object.keys(value.facts).some((key) => !(key in facts))) {
    return invalid("unknown enforcement fact");
  }
  return { ...policy, leaseId: binding.leaseId, provider: "aws", resourceId, boundaryId, facts };
}
export function verifyGuestAcquisition(
  value: unknown,
  binding: GuestNetworkBinding,
  leaseId: string,
  provider: string,
): GuestNetworkReceipt {
  if (
    !isRecord(value) ||
    value.exitCode !== 0 ||
    value.leaseId !== leaseId ||
    value.provider !== provider
  ) {
    return invalid("invalid acquisition timing identity/status");
  }
  return readGuestNetworkReceipt(value.guestNetwork, binding.expected, { leaseId, provider });
}
export function verifyGuestInspect(
  value: unknown,
  binding: GuestNetworkBinding,
  leaseId: string,
  provider: string,
): GuestNetworkReceipt {
  if (!binding.acquisition) {
    return invalid("missing acquisition receipt");
  }
  if (
    !isRecord(value) ||
    value.id !== leaseId ||
    value.provider !== provider ||
    value.providerResourceId !== binding.acquisition.resourceId
  ) {
    return invalid("inspect lease/provider/resource mismatch");
  }
  const receipt = readGuestNetworkReceipt(value.guestNetwork, binding.expected, {
    leaseId,
    provider,
    resourceId: value.providerResourceId,
  });
  if (!isDeepStrictEqual(receipt, binding.acquisition)) {
    return invalid("fresh inspection does not match acquired boundary/bootstrap identity");
  }
  return receipt;
}

/** CLI inspection resolves its recorded lease under current provider custody; no advertisement is accepted. */
export function verifyLiveGuestInspect(
  value: unknown,
  expected: GuestNetworkExpectation,
  leaseId: string,
  provider: string,
): GuestNetworkReceipt {
  if (
    !isRecord(value) ||
    value.id !== leaseId ||
    value.provider !== provider ||
    typeof value.providerResourceId !== "string"
  ) {
    return invalid("live lease/resource identity is unavailable");
  }
  return readGuestNetworkReceipt(value.guestNetwork, expected, {
    leaseId,
    provider,
    resourceId: value.providerResourceId,
  });
}
