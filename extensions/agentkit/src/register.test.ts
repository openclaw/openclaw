import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAgentkitRegisterPlanText,
  resolveAgentkitRegisterPlan,
  runAgentkitRegister,
} from "./register.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createExecutable(commandName: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-register-"));
  tempDirs.push(dir);
  const extension = process.platform === "win32" ? ".cmd" : "";
  const filePath = path.join(dir, `${commandName}${extension}`);
  await writeFile(
    filePath,
    process.platform === "win32" ? "@echo off\r\necho register\r\n" : "#!/bin/sh\necho register\n",
    "utf8",
  );
  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
  return dir;
}

describe("agentkit register plan", () => {
  it("resolves a registration invocation from plugin config", async () => {
    const executableDir = await createExecutable("agentkit");
    const plan = await resolveAgentkitRegisterPlan({
      appConfig: {
        plugins: {
          entries: {
            agentkit: {
              config: {
                walletAddress: "0x1234abcd",
              },
            },
          },
        },
      },
      env: {
        PATH: executableDir,
        PATHEXT: ".CMD;.EXE",
      },
    });

    expect(plan.walletAddress).toBe("0x1234abcd");
    expect(plan.args).toEqual(["register", "0x1234abcd"]);
    expect(plan.cliArgs).toEqual([]);
    expect(plan.resolvedPath).toMatch(new RegExp(`agentkit(?:\\.cmd)?$`, "i"));
    expect(formatAgentkitRegisterPlanText(plan)).toContain("AgentKit registration plan:");
  });

  it("prepends configured CLI args before the register invocation", async () => {
    const executableDir = await createExecutable("npx");
    const plan = await resolveAgentkitRegisterPlan({
      appConfig: {
        plugins: {
          entries: {
            agentkit: {
              config: {
                walletAddress: "0x1234abcd",
                cli: {
                  command: "npx",
                  args: ["-y", "@worldcoin/agentkit-cli"],
                },
              },
            },
          },
        },
      },
      env: {
        PATH: executableDir,
        PATHEXT: ".CMD;.EXE",
      },
    });

    expect(plan.command).toMatch(new RegExp(`npx(?:\\.cmd)?$`, "i"));
    expect(plan.cliArgs).toEqual(["-y", "@worldcoin/agentkit-cli"]);
    expect(plan.args).toEqual(["-y", "@worldcoin/agentkit-cli", "register", "0x1234abcd"]);
    expect(formatAgentkitRegisterPlanText(plan)).toContain(
      "- configured CLI args: -y @worldcoin/agentkit-cli",
    );
  });

  it("supports a wallet override", async () => {
    const executableDir = await createExecutable("agentkit");
    const plan = await resolveAgentkitRegisterPlan({
      appConfig: {},
      walletAddressOverride: "0xoverride",
      env: {
        PATH: executableDir,
        PATHEXT: ".CMD;.EXE",
      },
    });

    expect(plan.walletAddress).toBe("0xoverride");
  });

  it("fails when no wallet is available", async () => {
    const executableDir = await createExecutable("agentkit");
    await expect(
      resolveAgentkitRegisterPlan({
        appConfig: {},
        env: {
          PATH: executableDir,
          PATHEXT: ".CMD;.EXE",
        },
      }),
    ).rejects.toThrow("AgentKit wallet address is not configured");
  });

  it("fails when the cli executable is missing", async () => {
    await expect(
      resolveAgentkitRegisterPlan({
        appConfig: {
          plugins: {
            entries: {
              agentkit: {
                config: {
                  walletAddress: "0x1234abcd",
                },
              },
            },
          },
        },
        env: {
          PATH: "",
        },
      }),
    ).rejects.toThrow("AgentKit CLI command `agentkit` was not found on PATH");
  });
});

describe("agentkit register runner", () => {
  it("spawns the resolved registration command", async () => {
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit("close", 0);
      });
      return child as never;
    });

    await runAgentkitRegister({
      plan: {
        command: "/tmp/agentkit",
        args: ["register", "0x1234abcd"],
        walletAddress: "0x1234abcd",
        cliCommand: "agentkit",
        cliArgs: [],
        resolvedPath: "/tmp/agentkit",
      },
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      "/tmp/agentkit",
      ["register", "0x1234abcd"],
      expect.objectContaining({
        stdio: "inherit",
        shell: process.platform === "win32",
      }),
    );
  });
});
