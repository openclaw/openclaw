import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateEnvironmentsSessionCreateParams } from "./index.js";
import { EnvironmentsSessionCreateParamsSchema } from "./schema/environments-session.js";
import {
  parseWorkerMachineResources,
  WorkerMachineResourcesSchema,
} from "./schema/worker-machine-resources.js";

const request = { profileId: "cloud", idempotencyKey: "owned-request" };
describe("typed machine resource requests", () => {
  it("accepts provider-native sizing, region, and disk selectors through session creation", () => {
    const resources = {
      machineType: "Standard_D4s_v5",
      region: "eastus2",
      osDiskMode: "managed",
      osDiskSku: "Premium_LRS",
    };
    expect(Value.Check(EnvironmentsSessionCreateParamsSchema, { ...request, resources })).toBe(
      true,
    );
    expect(parseWorkerMachineResources(resources)).toEqual(resources);
    expect(validateEnvironmentsSessionCreateParams({ ...request, resources })).toBe(true);
  });
  it.each([
    {},
    { binary: "host-helper" },
    { configPath: "/host/config" },
    { endpoint: "https://control.example.test" },
    { instanceProfile: "privileged" },
    { serviceAccount: "privileged" },
    { mounts: ["/host"] },
    { env: { MODEL_AUTH: "canary" } },
    { machineType: "type --config /host" },
    { diskSizeGb: 0 },
    { diskSizeGb: 1.5 },
    { diskSizeGb: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects authority-bearing or unrepresentable resource input %#", (resources) => {
    expect(Value.Check(WorkerMachineResourcesSchema, resources)).toBe(false);
    expect(validateEnvironmentsSessionCreateParams({ ...request, resources })).toBe(false);
    expect(Value.Check(EnvironmentsSessionCreateParamsSchema, { ...request, resources })).toBe(
      false,
    );
  });
});
