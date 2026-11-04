import { WorkerProviderError, type WorkerResourceReceipt } from "openclaw/plugin-sdk/plugin-entry";
import {
  isGatewayAwsGuestReceipt,
  qualifyGatewayAwsGuestResource,
  type GatewayAwsAuthority,
  type GatewayAwsBoundary,
} from "./crabbox-worker-gateway-aws.js";
import type { ParsedInspect } from "./crabbox-worker-inspect.js";

/** Gateway-owned facts; no acquisition/expected-policy fields are sent to Crabbox. */
export type GuestNetworkBinding = GatewayAwsAuthority & {
  boundary: GatewayAwsBoundary;
  configureMetadata?: true;
  receipt?: WorkerResourceReceipt;
  recordResourceReceipt?: (receipt: WorkerResourceReceipt) => Promise<void>;
};
export async function verifyGuestInspect(
  inspect: ParsedInspect | undefined,
  binding: GuestNetworkBinding,
  leaseId: string,
  provider: string,
): Promise<void> {
  binding.assertCurrent();
  if (!inspect || inspect.id !== leaseId || provider !== "aws") {
    throw new WorkerProviderError(
      "Gateway-only AWS guest lease observation is unavailable or changed",
    );
  }
  if (!binding.configureMetadata && !isGatewayAwsGuestReceipt(binding.receipt)) {
    throw new WorkerProviderError(
      "Guest access requires the persisted Gateway-owned AWS resource receipt",
    );
  }
  const receipt = await qualifyGatewayAwsGuestResource({
    ...binding,
    leaseId,
    resourceId: inspect.providerResourceId ?? "",
    expected: binding.receipt,
    recordResourceReceipt: async (value) => {
      if (!binding.recordResourceReceipt) {
        throw new WorkerProviderError("AWS guest disk custody persistence unavailable");
      }
      await binding.recordResourceReceipt(value);
      binding.receipt = value;
    },
  });
  binding.assertCurrent();
  binding.receipt = receipt;
  inspect.resourceReceipt = receipt;
  // The AWS control plane, not the CLI's advertisement, just proved this fact.
  inspect.awsInstanceProfileAttached = false;
}
