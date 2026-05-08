import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentkitStatus } from "./status.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createExecutable(commandName: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-plugin-"));
  tempDirs.push(dir);
  const extension = process.platform === "win32" ? ".cmd" : "";
  const filePath = path.join(dir, `${commandName}${extension}`);
  await writeFile(
    filePath,
    process.platform === "win32" ? "@echo off\r\necho agentkit\r\n" : "#!/bin/sh\necho agentkit\n",
    "utf8",
  );
  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
  return dir;
}

describe("agentkit status", () => {
  it("reports an unconfigured plugin when the plugin entry is absent", async () => {
    const status = await resolveAgentkitStatus({
      appConfig: {},
      env: { PATH: "" },
    });

    expect(status.plugin.state).toBe("not-configured");
    expect(status.walletAddress).toBeNull();
    expect(status.cli.args).toEqual([]);
    expect(status.cli.available).toBe(false);
    expect(status.checks.readyForRegistration).toBe(false);
    expect(status.checks.readyForRuntime).toBe(false);
  });

  it("reports registration readiness when the wallet and local CLI are available", async () => {
    const executableDir = await createExecutable("npx");
    const status = await resolveAgentkitStatus({
      appConfig: {
        plugins: {
          entries: {
            agentkit: {
              enabled: true,
              config: {
                walletAddress: "0x1234abcd",
                cli: {
                  command: "npx",
                  args: ["-y", "@worldcoin/agentkit-cli"],
                },
                hitl: {
                  enabled: true,
                  mode: "delegation",
                  resourceUrl: "http://127.0.0.1:4126/protected",
                  protectedTools: ["bash"],
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

    expect(status.plugin.state).toBe("configured-enabled");
    expect(status.walletAddress).toBe("0x1234abcd");
    expect(status.hitl.enabled).toBe(true);
    expect(status.hitl.mode).toBe("delegation");
    expect(status.hitl.resourceUrl).toBe("http://127.0.0.1:4126/protected");
    expect(status.hitl.protectedTools).toEqual(["bash"]);
    expect(status.cli.args).toEqual(["-y", "@worldcoin/agentkit-cli"]);
    expect(status.cli.available).toBe(true);
    expect(status.cli.resolvedPath).toMatch(new RegExp(`npx(?:\\.cmd)?$`, "i"));
    expect(status.checks.readyForRegistration).toBe(true);
    expect(status.checks.readyForRuntime).toBe(true);
    expect(status.checks.readyForHitl).toBe(true);
  });

  it("requires an explicit hosted human-approval broker URL", async () => {
    const status = await resolveAgentkitStatus({
      appConfig: {
        plugins: {
          entries: {
            agentkit: {
              enabled: true,
              config: {
                hitl: {
                  enabled: true,
                  mode: "human-approval",
                  protectedTools: ["agents_list"],
                  humanApproval: {
                    provider: "hosted",
                  },
                },
              },
            },
          },
        },
      },
      env: {
        PATH: "",
      },
    });

    expect(status.hitl.humanApproval.provider).toBe("hosted");
    expect(status.hitl.humanApproval.brokerUrl).toBeNull();
    expect(status.checks.readyForHumanApproval).toBe(false);
    expect(status.checks.readyForHitl).toBe(false);
    expect(status.nextSteps.join("\n")).toContain("humanApproval.brokerUrl");
  });

  it("reports hosted human-approval readiness without requiring World app credentials", async () => {
    const brokerUrl = "https://agentkit.example.com/v1/world-id/sign-request";
    const status = await resolveAgentkitStatus({
      appConfig: {
        plugins: {
          entries: {
            agentkit: {
              enabled: true,
              config: {
                hitl: {
                  enabled: true,
                  mode: "human-approval",
                  protectedTools: ["agents_list"],
                  humanApproval: {
                    provider: "hosted",
                    brokerUrl,
                  },
                },
              },
            },
          },
        },
      },
      env: {
        PATH: "",
      },
    });

    expect(status.walletAddress).toBeNull();
    expect(status.hitl.mode).toBe("human-approval");
    expect(status.hitl.humanApproval.provider).toBe("hosted");
    expect(status.hitl.humanApproval.brokerUrl).toBe(brokerUrl);
    expect(status.hitl.humanApproval.appId).toBeNull();
    expect(status.hitl.humanApproval.rpId).toBeNull();
    expect(status.hitl.humanApproval.signingKeyConfigured).toBe(false);
    expect(status.checks.readyForRegistration).toBe(false);
    expect(status.checks.readyForHumanApproval).toBe(true);
    expect(status.checks.readyForHitl).toBe(true);
  });

  it("reports custom human-approval readiness without requiring an agent wallet", async () => {
    const status = await resolveAgentkitStatus({
      appConfig: {
        plugins: {
          entries: {
            agentkit: {
              enabled: true,
              config: {
                hitl: {
                  enabled: true,
                  mode: "human-approval",
                  protectedTools: ["agents_list"],
                  humanApproval: {
                    appId: "app_test",
                    rpId: "rp_test",
                    signingKeyEnvVar: "WORLD_SIGNING_KEY",
                    environment: "staging",
                  },
                },
              },
            },
          },
        },
      },
      env: {
        PATH: "",
        WORLD_SIGNING_KEY: "0xabc",
      },
    });

    expect(status.walletAddress).toBeNull();
    expect(status.hitl.mode).toBe("human-approval");
    expect(status.hitl.humanApproval.provider).toBe("custom");
    expect(status.hitl.humanApproval.appId).toBe("app_test");
    expect(status.hitl.humanApproval.rpId).toBe("rp_test");
    expect(status.hitl.humanApproval.signingKeyConfigured).toBe(true);
    expect(status.hitl.humanApproval.environment).toBe("staging");
    expect(status.checks.readyForRegistration).toBe(false);
    expect(status.checks.readyForHumanApproval).toBe(true);
    expect(status.checks.readyForHitl).toBe(true);
  });

  it("recommends an environment-backed World signing key for custom approvals", async () => {
    const status = await resolveAgentkitStatus({
      appConfig: {
        plugins: {
          entries: {
            agentkit: {
              enabled: true,
              config: {
                hitl: {
                  enabled: true,
                  mode: "human-approval",
                  protectedTools: ["agents_list"],
                  humanApproval: {
                    appId: "app_test",
                    rpId: "rp_test",
                  },
                },
              },
            },
          },
        },
      },
      env: {
        PATH: "",
      },
    });

    expect(status.checks.readyForHumanApproval).toBe(false);
    expect(status.nextSteps.join("\n")).toContain("humanApproval.signingKeyEnvVar");
  });
});
