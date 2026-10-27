import { expect, it, vi } from "vitest";
import { execContainer, PODMAN_SANDBOX_ENGINE } from "./container-engine.js";
import { retainSandboxContainerUsage } from "./container-usage.js";

const fixture = vi.hoisted(() => ({ calls: [] as string[][], failRetry: false }));
const id = (digit: string) => digit.repeat(64);
const entries = ["newer", "active", "background", "old"].map((name, index) => ({
  containerName: name,
  sessionKey: `agent:${name}:session`,
  backendId: "podman",
  backendTarget: { key: "local", globalArgs: [] },
  image: "synthetic",
  createdAtMs: 1,
  lastUsedAtMs: index === 0 ? 4 : index,
}));
// mock-isolation: synthetic custody and engine snapshots; production recovery owns selection and retry.
vi.mock("./registry.js", () => ({
  readRegistry: async () => ({ entries }),
  assertSandboxRegistryEntryCurrent: () => {},
}));
vi.mock("./state-owner.js", () => ({ captureSandboxStateOwner: async () => () => {} }));
vi.mock("./podman-runtime.js", () => ({
  validateSandboxContainerEngineTarget: async () => {},
}));
// mock-isolation: unfinished process snapshot avoids launching an actual background workload.
vi.mock("../bash-process-registry.js", () => ({
  listExecSessionsForCancellation: () => [{ agentId: "background", exited: false }],
}));
vi.mock("../../process/exec.js", async (original) => ({
  ...(await original<typeof import("../../process/exec.js")>()),
  spawnCommand: async ([, ...args]: string[]) => {
    fixture.calls.push(args);
    const failed =
      args[0] === "start" &&
      (fixture.failRetry || !fixture.calls.some(([verb]) => verb === "stop"));
    return {
      failed,
      isCanceled: false,
      exitCode: failed ? 125 : 0,
      stdout: Buffer.from(args[0] === "inspect" ? `${id("a")}\ntrue\ntrue\nhash\n` : ""),
      stderr: Buffer.from(failed ? "crun: create keyring 'container': Disk quota exceeded" : ""),
    };
  },
}));
it.each([false, true])(
  "reclaims only the LRU idle sandbox and retries once (still exhausted=%s)",
  async (failRetry) => {
    fixture.calls = [];
    fixture.failRetry = failRetry;
    using active = new DisposableStack();
    active.defer(retainSandboxContainerUsage("agent:active:session"));
    const start = execContainer(PODMAN_SANDBOX_ENGINE, ["start", id("c")]);
    if (failRetry) {
      await expect(start).rejects.toThrow(
        /per-user kernel keyring quota is exhausted.*kernel\.keys\.maxkeys.*kernel\.keys\.maxbytes above their current values.*\/etc\/sysctl\.d.*reduce running sandboxes/u,
      );
      await expect(start).rejects.not.toThrow("crun:");
    } else {
      await expect(start).resolves.toMatchObject({ code: 0 });
    }
    expect(fixture.calls.filter(([verb]) => verb !== "inspect")).toEqual([
      ["start", id("c")],
      ["stop", "--time", "10", id("a")],
      ["start", id("c")],
    ]);
    expect(fixture.calls.filter(([verb]) => verb === "inspect").map((args) => args.at(-1))).toEqual(
      ["old"],
    );
  },
);
