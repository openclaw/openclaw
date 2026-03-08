import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupManagedAotuiAppArtifacts,
  deriveAotuiRegistryName,
  installNpmAotuiPackage,
  parseAotuiInstallSource,
  resolveManagedAotuiAppCacheRoot,
} from "./install.js";

const rmMock = vi.hoisted(() => vi.fn(async () => undefined));
const readdirMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const rmdirMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: rmMock,
    readdir: readdirMock,
    rmdir: rmdirMock,
  };
});

describe("Agent App install helpers", () => {
  beforeEach(() => {
    rmMock.mockClear();
    readdirMock.mockClear();
    rmdirMock.mockClear();
  });

  it("parses npm specs into managed install descriptors", () => {
    expect(parseAotuiInstallSource("@agentina/aotui-ide")).toEqual({
      kind: "npm",
      source: "npm:@agentina/aotui-ide",
      packageName: "@agentina/aotui-ide",
      version: null,
      packageSpec: "@agentina/aotui-ide",
    });
  });

  it("parses local paths into absolute local sources", () => {
    const source = parseAotuiInstallSource("./fixtures/app", "/tmp/work");
    expect(source).toEqual({
      kind: "local",
      source: "local:/tmp/work/fixtures/app",
      absolutePath: "/tmp/work/fixtures/app",
    });
  });

  it("derives registry names from aliases, npm packages, and local paths", () => {
    expect(
      deriveAotuiRegistryName({
        parsedSource: parseAotuiInstallSource("@agentina/aotui-ide"),
      }),
    ).toBe("aotui-ide");
    expect(
      deriveAotuiRegistryName({
        parsedSource: parseAotuiInstallSource("./fixtures/my-app", "/tmp/work"),
      }),
    ).toBe("my-app");
    expect(
      deriveAotuiRegistryName({
        parsedSource: parseAotuiInstallSource("@agentina/aotui-ide"),
        alias: "ide",
      }),
    ).toBe("ide");
  });

  it("installs npm apps into the managed cache root", async () => {
    const cacheRoot = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-apps-")),
    );
    const commandRunner = vi.fn(async (_command: string, _args: string[], cwd: string) => {
      const pkgDir = path.join(cwd, "node_modules", "@agentina", "aotui-ide");
      await import("node:fs/promises").then((fs) => fs.mkdir(pkgDir, { recursive: true }));
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ name: "@agentina/aotui-ide", version: "1.2.3" }),
          "utf-8",
        ),
      );
    });

    const result = await installNpmAotuiPackage("@agentina/aotui-ide@1.2.3", {
      cacheRoot,
      commandRunner,
    });

    expect(result.installRoot).toBe(path.join(cacheRoot, "scope-agentina__aotui-ide", "1.2.3"));
    expect(result.localSource).toBe(`local:${result.installedPath}`);
    expect(result.resolvedVersion).toBe("1.2.3");
    expect(commandRunner).toHaveBeenCalledTimes(1);
  });

  it("only cleans up managed local app artifacts under the OpenClaw cache root", async () => {
    const managedSource = `local:${path.join(
      resolveManagedAotuiAppCacheRoot(),
      "scope-agentina__aotui-ide",
      "latest",
      "node_modules",
      "@agentina",
      "aotui-ide",
    )}`;

    const cleaned = await cleanupManagedAotuiAppArtifacts(managedSource);
    const skipped = await cleanupManagedAotuiAppArtifacts(
      `local:${path.join(os.homedir(), "projects", "my-aotui-app")}`,
    );

    expect(cleaned).toBe(true);
    expect(skipped).toBe(false);
  });
});
