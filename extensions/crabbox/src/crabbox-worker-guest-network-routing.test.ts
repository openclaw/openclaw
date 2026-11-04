import fs from "node:fs";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  run: vi.fn<
    (params: {
      args: string[];
    }) => Promise<{ termination: string; code: number; stdout: string; stderr: string }>
  >(),
}));
vi.mock("./crabbox-worker-command.js", () => ({
  runCrabboxCommand: state.run,
  crabboxCommandOutput: (_action: string, r: { stdout: string }) => r.stdout,
  parseCrabboxJson: (s: string) => JSON.parse(s),
}));
import {
  createCrabboxGuestCommandEnv,
  prepareCrabboxGuestNetwork,
} from "./crabbox-worker-preflight.js";
const fixture: unknown = JSON.parse(
  fs.readFileSync(
    new URL("./testdata/guest-network-caller-contract.json", import.meta.url),
    "utf8",
  ),
);
if (!isRecord(fixture) || !isRecord(fixture.managedServerCapability)) {
  throw new Error("invalid delivered fixture");
}
const serverPolicy = fixture.managedServerCapability.policy;
const reply = (value: unknown) => ({
  termination: "exit",
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});
const request = () =>
  prepareCrabboxGuestNetwork({
    binary: "synthetic-crabbox",
    provider: "aws",
    env: createCrabboxGuestCommandEnv({}),
    assertCurrent: () => {},
  });
beforeEach(() => state.run.mockReset());
it("qualifies direct configured policy without inventing a server handshake", async () => {
  state.run.mockResolvedValue(reply(fixture.directConfig));
  expect((await request()).expected.allocationRoute).toBe("direct");
  expect(state.run).toHaveBeenCalledOnce();
});
it("requires the actual versioned managed-server config handshake before returning expected policy", async () => {
  state.run.mockResolvedValueOnce(reply(fixture.managedCoordinatorConfig)).mockResolvedValueOnce(
    reply({
      provider: "aws",
      guestNetworkCapability: {
        version: 1,
        allocationRoute: "managed-coordinator",
        state: "implemented",
      },
      guestNetworkPolicy: serverPolicy,
    }),
  );
  const observed = await request();
  expect(observed.expected.policy.bootstrapMode).toBe("ssh-public-key-v1");
  expect(state.run.mock.calls[1]?.[0].args).toContain("--guest-network-server");
  expect(state.run.mock.calls.every(([p]) => p.args[0] === "config")).toBe(true);
});
it("old managed servers reject without reaching any allocation command", async () => {
  state.run
    .mockResolvedValueOnce(reply(fixture.managedCoordinatorConfig))
    .mockRejectedValueOnce(new Error("versioned handshake unavailable"));
  await expect(request()).rejects.toThrow("handshake unavailable");
  expect(state.run.mock.calls.every(([p]) => p.args[0] === "config")).toBe(true);
});
it("does not accept managed advertisement as authenticated qualification", async () => {
  state.run.mockResolvedValue(reply(fixture.managedCoordinatorConfig));
  await expect(request()).rejects.toThrow("not qualified");
});

it("rejects a managed handshake that substitutes the direct route before allocation", async () => {
  state.run
    .mockResolvedValueOnce(reply(fixture.managedCoordinatorConfig))
    .mockResolvedValueOnce(reply(fixture.directConfig));
  await expect(request()).rejects.toThrow("changed allocation route or bootstrap mode");
  expect(state.run.mock.calls.every(([p]) => p.args[0] === "config")).toBe(true);
});
