// Qa Lab tests cover desktop browser smoke plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisDesktopBrowserSmoke } from "./desktop-browser-smoke.runtime.js";

describe("mantis desktop browser smoke runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-desktop-browser-smoke-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  function createReusedLeaseRunner(copyArtifacts: (outputDir: string) => Promise<void>) {
    return vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_existing",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshUser: "crabbox",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        if (typeof outputDir !== "string") {
          throw new Error("rsync output directory is missing");
        }
        await fs.mkdir(outputDir, { recursive: true });
        await copyArtifacts(outputDir);
      }
      return { stdout: "", stderr: "" };
    });
  }

  it("leases a desktop box, runs a visible browser, copies artifacts, and stops on pass", async () => {
    await fs.mkdir(path.join(repoRoot, "qa-artifacts"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "qa-artifacts", "timeline.html"), "<h1>Mantis</h1>");
    const commands: { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const runtimeEnv = {
      PATH: process.env.PATH,
      CRABBOX_COORDINATOR_TOKEN: "runtime-token",
      OPENCLAW_MANTIS_CRABBOX_PROVIDER: "hetzner",
    };
    const runner = vi.fn(
      async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        commands.push({ command, args, env: options.env });
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_abc123\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.10",
              id: "cbx_abc123",
              provider: "hetzner",
              slug: "brisk-mantis",
              sshKey: "/tmp/key",
              sshPort: "2222",
              sshUser: "crabbox",
              state: "active",
            })}\n`,
            stderr: "",
          };
        }
        if (command === "rsync") {
          const outputDir = args.at(-1);
          expect(outputDir).toBeTypeOf("string");
          await fs.mkdir(outputDir as string, { recursive: true });
          await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.png"), "png");
          await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.mp4"), "mp4");
          await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
          await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
          await fs.writeFile(path.join(outputDir as string, "ffmpeg.log"), "ffmpeg\n");
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runMantisDesktopBrowserSmoke({
      browserUrl: "https://openclaw.ai/docs",
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: runtimeEnv,
      htmlFile: "qa-artifacts/timeline.html",
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-test",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
      ["rsync", "-az"],
      ["/tmp/crabbox", "stop"],
    ]);
    expect(commands.map((entry) => entry.env)).toEqual(commands.map(() => runtimeEnv));
    const rsyncArgs = commands.find((entry) => entry.command === "rsync")?.args ?? [];
    expect(rsyncArgs).not.toContain("--delete");
    const excludeIndex = rsyncArgs.indexOf("--exclude");
    expect(excludeIndex).toBeGreaterThanOrEqual(0);
    expect(rsyncArgs[excludeIndex + 1]).toBe("chrome-profile/**");
    expect(rsyncArgs).toContain(
      "crabbox@203.0.113.10:/tmp/openclaw-mantis-desktop-2026-05-04T12-00-00-000Z/",
    );
    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("${BROWSER:-}");
    expect(remoteScript).toContain("${CHROME_BIN:-}");
    expect(remoteScript).toContain("chromium-browser");
    expect(remoteScript).toContain("${OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64:-}");
    expect(remoteScript).toContain('"browserProfileRestored": $profile_restored');
    expect(remoteScript).toContain('"temporaryBrowserProfile": $temporary_profile');
    expect(remoteScript).toContain("-t 10");
    expect(remoteScript).toContain("base64 -d");
    expect(remoteScript).toContain("ffmpeg");
    expect(remoteScript).toContain('sudo apt-get update -y >>"$out/apt.log" 2>&1 || true');
    expect(remoteScript).toContain("desktop-browser-smoke.mp4");
    expect(remoteScript).not.toContain("-video_size");
    expect(remoteScript).toContain('url="file://$out/input.html"');
    expect(remoteScript).toContain('"browserBinary": "$browser_bin"');
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      browserUrl: string;
      crabbox: { id: string; vncCommand: string };
      htmlFile?: string;
      status: string;
    };
    expect(summary.browserUrl).toMatch(/^file:\/\//u);
    expect(summary.htmlFile).toBe(path.join(repoRoot, "qa-artifacts", "timeline.html"));
    expect(summary.status).toBe("pass");
    expect(summary.crabbox.id).toBe("cbx_abc123");
    expect(summary.crabbox.vncCommand).toBe(
      "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
    );
  });

  it("does not authenticate a reused output directory with an earlier screenshot or video", async () => {
    let copyCount = 0;
    const runner = createReusedLeaseRunner(async (outputDir) => {
      if (copyCount++ === 0) {
        await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "prior screenshot");
        await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.mp4"), "prior video");
      }
    });
    const options = {
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-reused",
      repoRoot,
    };

    const initial = await runMantisDesktopBrowserSmoke(options);
    expect(initial.status).toBe("pass");
    expect(initial.videoPath).toBeDefined();

    const rerun = await runMantisDesktopBrowserSmoke(options);
    expect(rerun.status).toBe("fail");
    expect(rerun.screenshotPath).toBeUndefined();
    expect(rerun.videoPath).toBeUndefined();
    await expect(
      fs.access(path.join(rerun.outputDir, "desktop-browser-smoke.png")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.access(path.join(rerun.outputDir, "desktop-browser-smoke.mp4")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("invalidates earlier visual evidence before lease inspection can fail", async () => {
    const outputDir = path.join(repoRoot, ".artifacts/qa-e2e/mantis/desktop-browser-inspect-fail");
    await fs.mkdir(outputDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "earlier screenshot"),
      fs.writeFile(path.join(outputDir, "desktop-browser-smoke.mp4"), "earlier video"),
      fs.writeFile(path.join(outputDir, "remote-metadata.json"), "keep unrelated evidence"),
    ]);
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        throw new Error("lease inspection failed");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: path.relative(repoRoot, outputDir),
      repoRoot,
    });

    expect(result.status).toBe("fail");
    await Promise.all(
      ["desktop-browser-smoke.png", "desktop-browser-smoke.mp4"].map(async (fileName) => {
        await expect(fs.lstat(path.join(outputDir, fileName))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    );
    await expect(fs.readFile(path.join(outputDir, "remote-metadata.json"), "utf8")).resolves.toBe(
      "keep unrelated evidence",
    );
  });

  it.each(["desktop-browser-smoke.png", "desktop-browser-smoke.mp4"])(
    "reports a preexisting %s directory without recursively deleting its contents",
    async (artifactName) => {
      const outputDir = path.join(repoRoot, ".artifacts/qa-e2e/mantis/desktop-browser-stale-dir");
      const artifactDir = path.join(outputDir, artifactName);
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(path.join(artifactDir, "unrelated.txt"), "preserve stale directory data");
      const siblingName =
        artifactName === "desktop-browser-smoke.png"
          ? "desktop-browser-smoke.mp4"
          : "desktop-browser-smoke.png";
      await fs.writeFile(path.join(outputDir, siblingName), "remove earlier sibling evidence");
      const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

      const result = await runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        leaseId: "cbx_existing",
        outputDir: path.relative(repoRoot, outputDir),
        repoRoot,
      });

      expect(result.status).toBe("fail");
      expect(runner).not.toHaveBeenCalled();
      await expect(fs.readFile(result.summaryPath, "utf8")).resolves.toContain('"status": "fail"');
      await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("Status: fail");
      await expect(fs.readFile(path.join(artifactDir, "unrelated.txt"), "utf8")).resolves.toBe(
        "preserve stale directory data",
      );
      await expect(fs.lstat(path.join(outputDir, siblingName))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([
    {
      expectedError: "Mantis browser profile archive env must be an environment variable name",
      name: "unsafe-profile-env",
      options: { browserProfileArchiveEnv: "BAD-NAME" },
    },
    {
      expectedError: "Mantis browser profile dir must be an absolute path",
      name: "unsafe-profile-dir",
      options: { browserProfileDir: "relative-profile" },
    },
    {
      expectedError: "ENOENT",
      name: "missing-html",
      options: { htmlFile: "missing-browser-proof.html" },
    },
  ])("clears previous captures before the $name option preflight rejects", async (testCase) => {
    const outputDir = path.join(repoRoot, `.artifacts/qa-e2e/mantis/${testCase.name}`);
    await fs.mkdir(outputDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "earlier screenshot"),
      fs.writeFile(path.join(outputDir, "desktop-browser-smoke.mp4"), "earlier video"),
      fs.writeFile(path.join(outputDir, "remote-metadata.json"), "keep unrelated evidence"),
    ]);
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        ...testCase.options,
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        leaseId: "cbx_existing",
        outputDir: path.relative(repoRoot, outputDir),
        repoRoot,
      }),
    ).rejects.toThrow(testCase.expectedError);

    expect(runner).not.toHaveBeenCalled();
    await Promise.all(
      ["desktop-browser-smoke.png", "desktop-browser-smoke.mp4"].map(async (fileName) => {
        await expect(fs.lstat(path.join(outputDir, fileName))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    );
    await expect(fs.readFile(path.join(outputDir, "remote-metadata.json"), "utf8")).resolves.toBe(
      "keep unrelated evidence",
    );
  });

  it("rejects an empty copied desktop screenshot", async () => {
    const runner = createReusedLeaseRunner(async (outputDir) => {
      await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "");
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-empty-screenshot",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      error?: string;
    };
    expect(summary.error).toMatch(/screenshot.*(?:missing|empty)/iu);
  });

  it.each([
    ["screenshot", "EACCES", "screenshot permission denied"],
    ["screenshot", "EIO", "screenshot filesystem I/O failed"],
    ["video", "EACCES", "video permission denied"],
    ["video", "EIO", "video filesystem I/O failed"],
  ])("reports unexpected %s inspection error %s", async (artifactKind, errorCode, errorMessage) => {
    const runner = createReusedLeaseRunner(async (outputDir) => {
      await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "current screenshot");
      await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.mp4"), "unvalidated video");
    });
    const failure = Object.assign(new Error(errorMessage), { code: errorCode });
    const originalLstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const artifactName =
        artifactKind === "screenshot" ? "desktop-browser-smoke.png" : "desktop-browser-smoke.mp4";
      if (args[0].toString().endsWith(`/${artifactName}`)) {
        throw failure;
      }
      return await originalLstat(...args);
    });

    try {
      const result = await runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        leaseId: "cbx_existing",
        outputDir: `.artifacts/qa-e2e/mantis/desktop-browser-${artifactKind}-error-${errorCode}`,
        repoRoot,
      });

      expect(result.status).toBe("fail");
      const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
        error?: string;
      };
      expect(summary.error).toContain(errorMessage);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it.each([
    ["screenshot", "EACCES"],
    ["screenshot", "EIO"],
    ["video", "EACCES"],
    ["video", "EIO"],
  ])(
    "sanitizes both captures when %s inspection fails with %s",
    async (failedArtifact, errorCode) => {
      const runner = createReusedLeaseRunner(async (outputDir) => {
        await Promise.all([
          fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), ""),
          fs.writeFile(path.join(outputDir, "desktop-browser-smoke.mp4"), ""),
        ]);
      });
      const failure = Object.assign(new Error(`${failedArtifact} artifact ${errorCode}`), {
        code: errorCode,
      });
      const originalLstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const artifactName =
          failedArtifact === "screenshot"
            ? "desktop-browser-smoke.png"
            : "desktop-browser-smoke.mp4";
        if (args[0].toString().endsWith(`/${artifactName}`)) {
          throw failure;
        }
        return await originalLstat(...args);
      });

      try {
        const result = await runMantisDesktopBrowserSmoke({
          commandRunner: runner,
          crabboxBin: "/tmp/crabbox",
          leaseId: "cbx_existing",
          outputDir: `.artifacts/qa-e2e/mantis/combined-inspection-${failedArtifact}-${errorCode}`,
          repoRoot,
        });

        expect(result.status).toBe("fail");
        const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
          error?: string;
        };
        expect(summary.error).toContain(`${failedArtifact} artifact ${errorCode}`);
        await Promise.all(
          ["desktop-browser-smoke.png", "desktop-browser-smoke.mp4"].map(async (fileName) => {
            await expect(fs.access(path.join(result.outputDir, fileName))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }),
        );
      } finally {
        lstatSpy.mockRestore();
      }
    },
  );

  it.each([
    ["screenshot", "regular"],
    ["video", "regular"],
    ["both", "regular"],
    ["both", "empty"],
    ["both", "symlink"],
    ["directory", "regular"],
  ])(
    "sanitizes %s %s captures copied before rsync rejects",
    async (captureSelection, captureType) => {
      const runner = createReusedLeaseRunner(async (outputDir) => {
        const screenshotPath = path.join(outputDir, "desktop-browser-smoke.png");
        const videoPath = path.join(outputDir, "desktop-browser-smoke.mp4");
        if (captureSelection === "directory") {
          await fs.mkdir(screenshotPath);
          await fs.writeFile(
            path.join(screenshotPath, "unrelated.txt"),
            "preserve nested evidence",
          );
          await fs.writeFile(videoPath, "partial video");
        } else if (captureType === "symlink") {
          await fs.writeFile(path.join(outputDir, "other-capture.png"), "preserve earlier image");
          await fs.writeFile(path.join(outputDir, "other-recording.mp4"), "preserve earlier video");
          await fs.symlink("other-capture.png", screenshotPath);
          await fs.symlink("other-recording.mp4", videoPath);
        } else {
          const content = captureType === "empty" ? "" : "partial capture";
          if (captureSelection === "screenshot" || captureSelection === "both") {
            await fs.writeFile(screenshotPath, content);
          }
          if (captureSelection === "video" || captureSelection === "both") {
            await fs.writeFile(videoPath, content);
          }
        }
        await fs.writeFile(path.join(outputDir, "remote-metadata.json"), "preserve unrelated copy");
        throw new Error("rsync transfer failed after writing partial captures");
      });

      const result = await runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        leaseId: "cbx_existing",
        outputDir: `.artifacts/qa-e2e/mantis/rsync-failure-${captureSelection}-${captureType}`,
        repoRoot,
      });

      expect(result.status).toBe("fail");
      const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
        error?: string;
      };
      expect(summary.error).toContain("rsync transfer failed after writing partial captures");
      await expect(
        fs.lstat(path.join(result.outputDir, "desktop-browser-smoke.mp4")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (captureSelection === "directory") {
        await expect(
          fs.readFile(
            path.join(result.outputDir, "desktop-browser-smoke.png", "unrelated.txt"),
            "utf8",
          ),
        ).resolves.toBe("preserve nested evidence");
      } else {
        await expect(
          fs.lstat(path.join(result.outputDir, "desktop-browser-smoke.png")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(
        fs.readFile(path.join(result.outputDir, "remote-metadata.json"), "utf8"),
      ).resolves.toBe("preserve unrelated copy");
      if (captureType === "symlink") {
        await expect(
          fs.readFile(path.join(result.outputDir, "other-capture.png"), "utf8"),
        ).resolves.toBe("preserve earlier image");
        await expect(
          fs.readFile(path.join(result.outputDir, "other-recording.mp4"), "utf8"),
        ).resolves.toBe("preserve earlier video");
      }
    },
  );

  it("rejects a copied screenshot symlink even when its target is a valid file", async () => {
    const runner = createReusedLeaseRunner(async (outputDir) => {
      await fs.writeFile(path.join(outputDir, "other-capture.png"), "earlier screenshot");
      await fs.symlink("other-capture.png", path.join(outputDir, "desktop-browser-smoke.png"));
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-screenshot-symlink",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    expect(result.screenshotPath).toBeUndefined();
    await expect(
      fs.lstat(path.join(result.outputDir, "desktop-browser-smoke.png")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(path.join(result.outputDir, "other-capture.png"), "utf8"),
    ).resolves.toBe("earlier screenshot");
  });

  it.each([
    ["missing", "empty"],
    ["missing", "existing symlink"],
    ["missing", "dangling symlink"],
    ["empty", "empty"],
    ["empty", "existing symlink"],
    ["empty", "dangling symlink"],
    ["symlink", "empty"],
    ["symlink", "existing symlink"],
    ["symlink", "dangling symlink"],
    ["directory", "empty"],
    ["directory", "existing symlink"],
    ["directory", "dangling symlink"],
  ])(
    "sanitizes a %s screenshot and %s video before reporting screenshot failure",
    async (screenshotState, videoState) => {
      const runner = createReusedLeaseRunner(async (outputDir) => {
        const screenshotPath = path.join(outputDir, "desktop-browser-smoke.png");
        if (screenshotState === "empty") {
          await fs.writeFile(screenshotPath, "");
        } else if (screenshotState === "symlink") {
          await fs.writeFile(path.join(outputDir, "other-capture.png"), "preserve earlier image");
          await fs.symlink("other-capture.png", screenshotPath);
        } else if (screenshotState === "directory") {
          await fs.mkdir(screenshotPath);
          await fs.writeFile(
            path.join(screenshotPath, "unrelated.txt"),
            "preserve nested evidence",
          );
        }

        const videoPath = path.join(outputDir, "desktop-browser-smoke.mp4");
        if (videoState === "empty") {
          await fs.writeFile(videoPath, "");
        } else {
          if (videoState === "existing symlink") {
            await fs.writeFile(
              path.join(outputDir, "other-recording.mp4"),
              "preserve earlier video",
            );
          }
          await fs.symlink("other-recording.mp4", videoPath);
        }
      });

      const result = await runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        leaseId: "cbx_existing",
        outputDir: `.artifacts/qa-e2e/mantis/combined-${screenshotState}-${videoState.replace(/ /gu, "-")}`,
        repoRoot,
      });

      expect(result.status).toBe("fail");
      expect(result.screenshotPath).toBeUndefined();
      expect(result.videoPath).toBeUndefined();
      await expect(
        fs.lstat(path.join(result.outputDir, "desktop-browser-smoke.mp4")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (screenshotState === "directory") {
        await expect(
          fs.readFile(
            path.join(result.outputDir, "desktop-browser-smoke.png", "unrelated.txt"),
            "utf8",
          ),
        ).resolves.toBe("preserve nested evidence");
      } else {
        await expect(
          fs.lstat(path.join(result.outputDir, "desktop-browser-smoke.png")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      if (screenshotState === "symlink") {
        await expect(
          fs.readFile(path.join(result.outputDir, "other-capture.png"), "utf8"),
        ).resolves.toBe("preserve earlier image");
      }
      if (videoState === "existing symlink") {
        await expect(
          fs.readFile(path.join(result.outputDir, "other-recording.mp4"), "utf8"),
        ).resolves.toBe("preserve earlier video");
      }
    },
  );

  it("does not attach an earlier video when a rerun captures only a fresh screenshot", async () => {
    let copyCount = 0;
    const runner = createReusedLeaseRunner(async (outputDir) => {
      await fs.writeFile(
        path.join(outputDir, "desktop-browser-smoke.png"),
        `screenshot ${copyCount}`,
      );
      if (copyCount++ === 0) {
        await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.mp4"), "prior video");
      }
    });
    const options = {
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-video-reused",
      repoRoot,
    };

    expect((await runMantisDesktopBrowserSmoke(options)).videoPath).toBeDefined();
    const rerun = await runMantisDesktopBrowserSmoke(options);
    expect(rerun.status).toBe("pass");
    expect(rerun.videoPath).toBeUndefined();
    await expect(fs.readFile(rerun.screenshotPath ?? "", "utf8")).resolves.toBe("screenshot 1");
    await expect(
      fs.access(path.join(rerun.outputDir, "desktop-browser-smoke.mp4")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps video optional without advertising an empty recording", async () => {
    const runner = createReusedLeaseRunner(async (outputDir) => {
      await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "current screenshot");
      await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.mp4"), "");
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-empty-video",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(result.videoPath).toBeUndefined();
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      artifacts?: { videoPath?: string };
    };
    expect(summary.artifacts?.videoPath).toBeUndefined();
    await expect(
      fs.access(path.join(result.outputDir, "desktop-browser-smoke.mp4")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["existing", "missing"])(
    "removes an optional video symlink with an %s target",
    async (targetState) => {
      const runner = createReusedLeaseRunner(async (outputDir) => {
        await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "current screenshot");
        if (targetState === "existing") {
          await fs.writeFile(path.join(outputDir, "other-recording.mp4"), "earlier recording");
        }
        await fs.symlink("other-recording.mp4", path.join(outputDir, "desktop-browser-smoke.mp4"));
      });

      const result = await runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        leaseId: "cbx_existing",
        outputDir: `.artifacts/qa-e2e/mantis/desktop-browser-video-symlink-${targetState}`,
        repoRoot,
      });

      expect(result.status).toBe("pass");
      expect(result.videoPath).toBeUndefined();
      await expect(
        fs.lstat(path.join(result.outputDir, "desktop-browser-smoke.mp4")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (targetState === "existing") {
        await expect(
          fs.readFile(path.join(result.outputDir, "other-recording.mp4"), "utf8"),
        ).resolves.toBe("earlier recording");
      }
    },
  );

  it("rejects an optional video directory without removing its unrelated contents", async () => {
    const runner = createReusedLeaseRunner(async (outputDir) => {
      await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "current screenshot");
      const videoDir = path.join(outputDir, "desktop-browser-smoke.mp4");
      await fs.mkdir(videoDir);
      await fs.writeFile(path.join(videoDir, "unrelated.txt"), "do not recursively delete");
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-video-directory",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    await expect(
      fs.readFile(
        path.join(result.outputDir, "desktop-browser-smoke.mp4", "unrelated.txt"),
        "utf8",
      ),
    ).resolves.toBe("do not recursively delete");
  });

  it("rejects html files outside the repository", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        htmlFile: "../outside.html",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-outside",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis desktop HTML file must be inside the repository");
    expect(runner).not.toHaveBeenCalled();
  });

  it("restores a named browser profile archive env and honors the video duration", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_existing",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshUser: "crabbox",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.png"), "png");
        await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.mp4"), "mp4");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisDesktopBrowserSmoke({
      browserProfileArchiveEnv: "MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64",
      browserProfileDir: "$HOME/.config/openclaw-mantis/discord-viewer-chrome-profile",
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
      repoRoot,
      videoDurationSeconds: 24,
    });

    expect(result.status).toBe("pass");

    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("${MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64:-}");
    expect(remoteScript).toContain(
      "profile='$HOME/.config/openclaw-mantis/discord-viewer-chrome-profile'",
    );
    expect(remoteScript).toContain("temporary_profile=false");
    expect(remoteScript).toContain('tar -xzf "$profile_archive" -C "$profile"');
    expect(remoteScript).toContain("-t 24");
  });

  it("rejects unsafe browser profile archive env names", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        browserProfileArchiveEnv: "BAD-NAME",
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis browser profile archive env must be an environment variable name");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects relative browser profile dirs", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        browserProfileDir: "relative-profile",
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis browser profile dir must be an absolute path");
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts Blacksmith Testbox lease ids from Crabbox warmup", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready: tbx_abc-123_more\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "tbx_abc-123_more",
            provider: "blacksmith-testbox",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.png"), "png");
        await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
        await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      now: () => new Date("2026-05-04T12:30:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-testbox",
      provider: "blacksmith-testbox",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    const commandWithLeaseId = commands.find(
      (entry) => entry.command === "/tmp/crabbox" && entry.args.includes("tbx_abc-123_more"),
    );
    expect(commandWithLeaseId?.args).toContain("--id");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; provider: string };
    };
    expect(summary.crabbox.id).toBe("tbx_abc-123_more");
    expect(summary.crabbox.provider).toBe("blacksmith-testbox");
  });

  it("keeps an existing lease and writes failure reports when the remote run fails", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_existing",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "/tmp/crabbox" && args[0] === "run") {
        throw new Error("remote chrome failed");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-fail",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
    ]);
    await expect(fs.readFile(path.join(result.outputDir, "error.txt"), "utf8")).resolves.toContain(
      "remote chrome failed",
    );
  });
});
