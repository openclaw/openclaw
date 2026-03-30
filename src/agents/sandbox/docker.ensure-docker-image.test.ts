import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SpawnCall = {
  command: string;
  args: string[];
};

type MockDockerChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (input?: string | Buffer) => void };
  kill: (signal?: NodeJS.Signals) => void;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  inspectResults: new Map<string, { code: number; stdout?: string; stderr?: string }>(),
}));

function createMockDockerChild(): MockDockerChild {
  const child = new EventEmitter() as MockDockerChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: () => undefined };
  child.kill = () => undefined;
  return child;
}

function spawnDockerProcess(command: string, args: string[]) {
  spawnState.calls.push({ command, args });
  const child = createMockDockerChild();

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "image" && args[1] === "inspect") {
    const image = args[2] ?? "";
    const result = spawnState.inspectResults.get(image);
    code = result?.code ?? 1;
    stdout = result?.stdout ?? "";
    stderr = result?.stderr ?? `Error: No such image: ${image}`;
  } else {
    code = 0;
  }

  queueMicrotask(() => {
    if (stdout) {
      child.stdout.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      child.stderr.emit("data", Buffer.from(stderr));
    }
    child.emit("close", code);
  });

  return child;
}

async function createChildProcessMock(
  importOriginal: () => Promise<typeof import("node:child_process")>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: spawnDockerProcess,
  };
}

vi.mock("node:child_process", async (importOriginal) =>
  createChildProcessMock(() => importOriginal<typeof import("node:child_process")>()),
);

let ensureDockerImage: typeof import("./docker.js").ensureDockerImage;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("node:child_process", async (importOriginal) =>
    createChildProcessMock(() => importOriginal<typeof import("node:child_process")>()),
  );
  ({ ensureDockerImage } = await import("./docker.js"));
}

describe("ensureDockerImage", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.inspectResults.clear();
    await loadFreshDockerModuleForTest();
  });

  it("fails fast with an actionable message when the default sandbox image is missing", async () => {
    spawnState.inspectResults.set("openclaw-sandbox:bookworm-slim", {
      code: 1,
      stderr: "Error: No such image: openclaw-sandbox:bookworm-slim",
    });

    let err: unknown;
    try {
      await ensureDockerImage("openclaw-sandbox:bookworm-slim");
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/scripts\/sandbox-setup\.sh/);
    expect((err as Error).message).toMatch(/python3/);

    const dockerCalls = spawnState.calls.filter((call) => call.command === "docker");
    expect(dockerCalls).toHaveLength(1);
    expect(
      dockerCalls.every((call) => call.args[0] === "image" && call.args[1] === "inspect"),
    ).toBe(true);
    expect(dockerCalls.some((call) => call.args[0] === "pull")).toBe(false);
    expect(dockerCalls.some((call) => call.args[0] === "tag")).toBe(false);
  });

  it("keeps the generic message for non-default images", async () => {
    spawnState.inspectResults.set("ghcr.io/example/custom-sandbox:latest", {
      code: 1,
      stderr: "Error: No such image: ghcr.io/example/custom-sandbox:latest",
    });

    await expect(ensureDockerImage("ghcr.io/example/custom-sandbox:latest")).rejects.toThrow(
      /Build or pull it first/,
    );
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]?.args).toEqual([
      "image",
      "inspect",
      "ghcr.io/example/custom-sandbox:latest",
    ]);
  });
});
