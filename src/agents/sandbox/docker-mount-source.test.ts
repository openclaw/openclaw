import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCKER_SANDBOX_ENGINE, execContainer, PODMAN_SANDBOX_ENGINE } from "./container-engine.js";
import {
  parseInspectedSandboxMounts,
  resolveDockerSourceNamespace,
  translateSandboxMountSources,
} from "./docker-mount-source.js";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    readlinkSync: vi.fn(),
    existsSync: vi.fn(),
    realpathSync: vi.fn(),
  },
}));
vi.mock("node:os", () => ({ default: { hostname: vi.fn() } }));
vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  PODMAN_SANDBOX_ENGINE: { id: "podman", command: "podman", displayName: "Podman" },
  execContainer: vi.fn(),
}));

const id = "a".repeat(64);
const identity = JSON.stringify(["test-boot", "mnt:[123]"]);
const wireMount = {
  Type: "bind",
  Source: "/host/project",
  Destination: "/gateway/workspace",
  RW: true,
};
let target = 0;

function translateSandboxMountSource(
  params: Omit<
    Parameters<typeof translateSandboxMountSources>[0],
    "containerPath" | "shadowedTargets"
  >,
): string {
  return translateSandboxMountSources({
    ...params,
    containerPath: "/workspace",
    shadowedTargets: [],
  })[0]!.hostPath;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.stubEnv("DOCKER_CONTEXT", `test-${++target}`);
  vi.mocked(os.hostname).mockReturnValue("gateway-hostname");
  vi.mocked(fs.existsSync).mockImplementation((file) => file === "/.dockerenv");
  vi.mocked(fs.readlinkSync).mockReturnValue("mnt:[123]");
  vi.mocked(fs.readFileSync).mockImplementation((file) =>
    file === "/proc/sys/kernel/random/boot_id" ? "test-boot\n" : "0::/\n",
  );
  vi.mocked(fs.realpathSync).mockImplementation((file) => String(file));
  vi.mocked(execContainer).mockImplementation(async (_engine, args) => ({
    stdout: args[0] === "inspect" ? JSON.stringify({ Id: id, Mounts: [wireMount] }) : identity,
    stderr: "",
    code: 0,
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Docker source namespace", () => {
  it("proves a custom hostname on private cgroup v2 before accepting mounts, and shares the snapshot", async () => {
    const [first, second] = await Promise.all([
      resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE),
      resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE),
    ]);
    expect(first).toEqual(parseInspectedSandboxMounts([wireMount]));
    expect(second).toBe(first);
    expect(execContainer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execContainer).mock.calls[0]?.[1]).toEqual([
      "inspect",
      "--type",
      "container",
      "--format",
      '{"Id":{{json .ID}},"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}',
      "gateway-hostname",
    ]);
    expect(vi.mocked(execContainer).mock.calls[1]?.[1].slice(0, 4)).toEqual([
      "exec",
      id,
      process.execPath,
      "-e",
    ]);
    expect(vi.mocked(execContainer).mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a mountinfo container ID when the hostname is not a Docker name", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((file) =>
      file === "/proc/self/mountinfo"
        ? `1 2 0:1 /var/lib/docker/containers/${id}/hostname /etc/hostname rw - ext4 /dev/test rw`
        : file === "/proc/sys/kernel/random/boot_id"
          ? "test-boot"
          : "0::/\n",
    );
    vi.mocked(execContainer).mockRejectedValueOnce(new Error("No such container"));
    await expect(resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE)).resolves.toHaveLength(1);
    expect(vi.mocked(execContainer).mock.calls[1]?.[1].at(-1)).toBe(id);
  });

  it.each(["/gateway/workspace", "/gateway/workspace/data"])(
    "rejects Docker --tmpfs at %s even when .Mounts only reports its bind ancestor",
    async (destination) => {
      vi.mocked(execContainer).mockResolvedValueOnce({
        stdout: JSON.stringify({
          Id: id,
          Mounts: [wireMount],
          Tmpfs: { [destination]: "rw,size=1m" },
        }),
        stderr: "",
        code: 0,
      });
      const mounts = await resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE);
      expect(() =>
        translateSandboxMountSource({
          source: "/gateway/workspace",
          allowedRoots: ["/gateway/workspace"],
          mounts: mounts!,
          readOnly: false,
        }),
      ).toThrow(/unsupported (?:nested )?tmpfs mount/);
    },
  );

  it.each(["wrong-boot", "wrong-namespace", "invalid-id", "missing-mounts", "unavailable"])(
    "rejects %s without a wrong-path fallback and retries after recovery",
    async (failure) => {
      if (failure === "unavailable") {
        vi.mocked(execContainer).mockRejectedValueOnce(new Error("daemon unavailable"));
      } else if (failure === "invalid-id" || failure === "missing-mounts") {
        vi.mocked(execContainer).mockResolvedValueOnce({
          stdout: JSON.stringify({
            Id: failure === "invalid-id" ? "short-id" : id,
            Mounts: failure === "missing-mounts" ? null : [wireMount],
          }),
          stderr: "",
          code: 0,
        });
      } else {
        vi.mocked(execContainer)
          .mockImplementationOnce(async () => ({
            stdout: JSON.stringify({ Id: id, Mounts: [wireMount] }),
            stderr: "",
            code: 0,
          }))
          .mockResolvedValueOnce({
            stdout: JSON.stringify(
              failure === "wrong-boot" ? ["other-boot", "mnt:[123]"] : ["test-boot", "mnt:[456]"],
            ),
            stderr: "",
            code: 0,
          });
      }
      await expect(resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE)).rejects.toThrow(
        "Connect Docker to the daemon that runs the Gateway",
      );
      await expect(resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE)).resolves.toHaveLength(1);
    },
  );

  it("leaves native Docker and Podman sources unchanged without self-inspection", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue(
      `1 2 0:1 / /var/lib/docker/overlay2/${id}/merged rw - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/${id}`,
    );
    await expect(resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE)).resolves.toBeUndefined();
    await expect(resolveDockerSourceNamespace(PODMAN_SANDBOX_ENGINE)).resolves.toBeUndefined();
    expect(execContainer).not.toHaveBeenCalled();
  });
});

describe("managed source translation", () => {
  it("keeps literal backslashes in inspected sources and Gateway mount selection", () => {
    const mounts = parseInspectedSandboxMounts([
      { ...wireMount, Source: "/host/a\\b", Destination: "/gateway/a\\b" },
      { ...wireMount, Source: "/host/a/b", Destination: "/gateway/a/b" },
    ]);
    for (const suffix of ["a\\b", "a/b"]) {
      expect(
        translateSandboxMountSource({
          readOnly: false,
          source: `/gateway/${suffix}/leaf`,
          allowedRoots: [`/gateway/${suffix}`],
          mounts,
        }),
      ).toBe(`/host/${suffix}/leaf`);
    }
  });

  it("uses the longest segment prefix and preserves spaces", () => {
    const mounts = parseInspectedSandboxMounts([
      wireMount,
      { ...wireMount, Source: "/host/special skills", Destination: "/gateway/workspace/skills" },
    ]);
    expect(
      translateSandboxMountSource({
        readOnly: false,
        source: "/gateway/workspace/skills/demo",
        allowedRoots: ["/gateway/workspace"],
        mounts,
      }),
    ).toBe("/host/special skills/demo");
    expect(() =>
      translateSandboxMountSource({
        readOnly: false,
        source: "/gateway/workspace-other",
        allowedRoots: ["/gateway/workspace-other"],
        mounts,
      }),
    ).toThrow("not backed by a Gateway bind mount");
  });

  it.each(["volume", "tmpfs"])("does not reinterpret %s storage as a host bind", (type) => {
    const mounts = parseInspectedSandboxMounts([
      { ...wireMount, Type: type, Source: "/var/lib/docker/private" },
    ]);
    expect(() =>
      translateSandboxMountSource({
        readOnly: false,
        source: "/gateway/workspace",
        allowedRoots: ["/gateway/workspace"],
        mounts,
      }),
    ).toThrow(`unsupported ${type} mount`);
  });

  it("rejects relative daemon sources", () => {
    expect(() => parseInspectedSandboxMounts([{ ...wireMount, Source: "relative" }])).toThrow(
      "invalid mount entry",
    );
    expect(() => parseInspectedSandboxMounts([wireMount], { relative: "rw" })).toThrow(
      "invalid tmpfs destination",
    );
  });

  it("maps a root destination without losing the separator", () => {
    expect(
      translateSandboxMountSource({
        readOnly: false,
        source: "/workspace",
        allowedRoots: ["/workspace"],
        mounts: parseInspectedSandboxMounts([{ ...wireMount, Destination: "/" }]),
      }),
    ).toBe("/host/project/workspace");
  });

  it("preserves Windows drive sources in container inspection", () => {
    expect(
      parseInspectedSandboxMounts([{ ...wireMount, Source: "c:\\Users\\Example\\project" }])[0]
        ?.source,
    ).toBe("C:/Users/Example/project");
  });

  it("does not grant writes through a read-only Gateway bind", () => {
    const params = {
      source: "/gateway/workspace",
      allowedRoots: ["/gateway/workspace"],
      mounts: parseInspectedSandboxMounts([{ ...wireMount, RW: false }]),
    };
    expect(() => translateSandboxMountSource({ ...params, readOnly: false })).toThrow(
      "Use workspaceAccess=ro",
    );
    expect(translateSandboxMountSource({ ...params, readOnly: true })).toBe("/host/project");
  });

  it("checks symlink containment locally and never resolves a daemon source locally", () => {
    vi.mocked(fs.realpathSync).mockImplementation((file) =>
      file === "/gateway/workspace/escape" ? "/etc" : String(file),
    );
    expect(() =>
      translateSandboxMountSource({
        readOnly: false,
        source: "/gateway/workspace/escape",
        allowedRoots: ["/gateway/workspace"],
        mounts: parseInspectedSandboxMounts([wireMount]),
      }),
    ).toThrow("escapes its Gateway workspace roots");
    translateSandboxMountSource({
      readOnly: false,
      source: "/gateway/workspace",
      allowedRoots: ["/gateway/workspace"],
      mounts: parseInspectedSandboxMounts([wireMount]),
    });
    expect(
      vi.mocked(fs.realpathSync).mock.calls.some(([file]) => String(file).startsWith("/host/")),
    ).toBe(false);
  });
});
