import { expect, it, vi } from "vitest";
import { qualifyGatewayAwsGuestResource } from "./crabbox-worker-gateway-aws.js";
import { verifyGuestInspect } from "./crabbox-worker-guest-network.js";
import { parseInspectJson } from "./crabbox-worker-inspect.js";
vi.mock("./crabbox-worker-gateway-aws.js", () => ({
  qualifyGatewayAwsGuestResource: vi.fn(),
  isGatewayAwsGuestReceipt: (receipt: unknown) => receipt !== undefined,
}));
const boundary = {
  region: "us-east-1",
  accountId: "123456789012",
  groupId: "sg-0123456789abcdef0",
  subnetId: "subnet-0123456789abcdef0",
  vpcId: "vpc-0123456789abcdef0",
  rulesDigest: "synthetic-digest",
};
it("requires independent Gateway proof even when a CLI response advertises a guest policy", async () => {
  const inspect = parseInspectJson(
    JSON.stringify({
      id: "cbx_fixture",
      serverId: "i-0123456789abcdef0",
      state: "RUNNING",
      ready: true,
      guestNetwork: { version: 1, isolationBoundaryApplied: true },
    }),
  );
  vi.mocked(qualifyGatewayAwsGuestResource).mockRejectedValueOnce(
    new Error("independent provider boundary denied"),
  );
  await expect(
    verifyGuestInspect(
      inspect,
      { boundary, configureMetadata: true, assertCurrent: () => {} },
      "cbx_fixture",
      "aws",
    ),
  ).rejects.toThrow("independent provider");
});
it("does not qualify an old guest without its persisted Gateway-owned identity", async () => {
  const inspect = parseInspectJson(
    JSON.stringify({ id: "cbx_fixture", state: "RUNNING", ready: true }),
  );
  await expect(
    verifyGuestInspect(inspect, { boundary, assertCurrent: () => {} }, "cbx_fixture", "aws"),
  ).rejects.toThrow("persisted");
});
