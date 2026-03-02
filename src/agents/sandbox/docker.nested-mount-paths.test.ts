import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./types.js";

const execDocker = vi.hoisted(() => vi.fn());
const readRegistry = vi.hoisted(() => vi.fn(async () => ({ entries: [] })));
const updateRegistry = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker.js")>();
  return {
    ...actual,
    execDocker,
  };
});

vi.mock("./registry.js", () => ({
  readRegistry,
  updateRegistry,
}));

describe("ensureSandboxContainer nested docker workspace bind source", () => {
  const originalHostname = process.env.HOSTNAME;
  const originalReadFile = fs.readFile;

  beforeEach(() => {
    vi.resetModules();
    execDocker.mockReset();
    readRegistry.mockReset();
    updateRegistry.mockReset();
    readRegistry.mockResolvedValue({ entries: [] });
    updateRegistry.mockResolvedValue(undefined);
    process.env.HOSTNAME = "gateway";
  });

  afterEach(() => {
    process.env.HOSTNAME = originalHostname;
    vi.restoreAllMocks();
    (fs.readFile as unknown as typeof originalReadFile) = originalReadFile;
  });

  it("maps container workspace path to host bind source from mountinfo", async () => {
    const mountLine =
      "36 35 0:42 / /home/node/.openclaw/workspace rw,relatime - ext4 /DATA/openclaw/workspace rw";
    vi.spyOn(fs, "readFile").mockImplementation(async (p: fs.PathLike, _enc?: BufferEncoding) => {
      if (String(p) === "/proc/self/mountinfo") {
        return mountLine;
      }
      throw new Error(`unexpected read: ${String(p)}`);
    });

    execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "inspect" && args[1] === "-f") {
        // readDockerContainerEnvVar for OPENCLAW_SANDBOX_HOST_WORKSPACE on current container
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "inspect") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "create") {
        const mountArgIndex = args.indexOf("-v");
        expect(mountArgIndex).toBeGreaterThan(0);
        expect(args[mountArgIndex + 1]).toBe("/DATA/openclaw/workspace:/workspace");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { ensureSandboxContainer } = await import("./docker.js");
    const cfg: SandboxConfig = {
      mode: "all",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/home/node/.openclaw/sandboxes",
      docker: {
        image: "openclaw-sandbox:bookworm-slim",
        containerPrefix: "openclaw-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp", "/var/tmp", "/run"],
        network: "none",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      browser: {
        enabled: false,
        image: "openclaw-sandbox-browser:bookworm-slim",
        containerPrefix: "openclaw-sbx-browser-",
        network: "openclaw-sandbox-browser",
        cdpPort: 9222,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true,
        allowHostControl: false,
        autoStart: true,
        autoStartTimeoutMs: 12_000,
      },
      tools: {},
      prune: { idleHours: 24, maxAgeDays: 7 },
    };

    await ensureSandboxContainer({
      sessionKey: "agent:main:main",
      workspaceDir: "/home/node/.openclaw/workspace",
      agentWorkspaceDir: "/home/node/.openclaw/workspace",
      cfg,
    });
  });
});
