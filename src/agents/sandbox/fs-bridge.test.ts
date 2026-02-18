import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./docker.js", () => ({
  execDockerRaw: vi.fn(),
}));

import { execDockerRaw } from "./docker.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

const mockedExecDockerRaw = vi.mocked(execDockerRaw);

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({
    overrides: {
      containerName: "moltbot-sbx-test",
      ...overrides,
    },
    dockerOverrides: {
      image: "moltbot-sandbox:bookworm-slim",
      containerPrefix: "moltbot-sbx-",
    },
  });
}

describe("sandbox fs bridge shell compatibility", () => {
  beforeEach(() => {
    mockedExecDockerRaw.mockReset();
    mockedExecDockerRaw.mockImplementation(async (args) => {
      const script = args[5] ?? "";
      if (script.includes('stat -c "%F|%s|%Y"')) {
        return {
          stdout: Buffer.from("regular file|1|2"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      }
      if (script.includes('cat -- "$1"')) {
        return {
          stdout: Buffer.from("content"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      }
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      };
    });
  });

  it("uses POSIX-safe shell prologue in all bridge commands", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.readFile({ filePath: "a.txt" });
    await bridge.writeFile({ filePath: "b.txt", data: "hello" });
    await bridge.mkdirp({ filePath: "nested" });
    await bridge.remove({ filePath: "b.txt" });
    await bridge.rename({ from: "a.txt", to: "c.txt" });
    await bridge.stat({ filePath: "c.txt" });

    expect(mockedExecDockerRaw).toHaveBeenCalled();

    const scripts = mockedExecDockerRaw.mock.calls.map(([args]) => args[5] ?? "");
    const executables = mockedExecDockerRaw.mock.calls.map(([args]) => args[3] ?? "");

    expect(executables.every((shell) => shell === "sh")).toBe(true);
    expect(scripts.every((script) => script.includes("set -eu;"))).toBe(true);
    expect(scripts.some((script) => script.includes("pipefail"))).toBe(false);
  });

  it("resolves bind-mounted absolute container paths for reads", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await bridge.readFile({ filePath: "/workspace-two/README.md" });

    const args = mockedExecDockerRaw.mock.calls.at(-1)?.[0] ?? [];
    expect(args).toEqual(
      expect.arrayContaining(["moltbot-sbx-test", "sh", "-c", 'set -eu; cat -- "$1"']),
    );
    expect(args.at(-1)).toBe("/workspace-two/README.md");
  });

  it("blocks writes into read-only bind mounts", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await expect(
      bridge.writeFile({ filePath: "/workspace-two/new.txt", data: "hello" }),
    ).rejects.toThrow(/read-only/);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });
});
