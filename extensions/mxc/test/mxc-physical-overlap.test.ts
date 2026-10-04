import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildMxcContainerConfig,
  resolveMxcWorkspaceContext,
} from "../src/mxc-container-config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const root = tempDirs.make("mxc-physical-overlap-");
  const directory = (...parts: string[]) => {
    const result = path.join(root, ...parts);
    fs.mkdirSync(result, { recursive: true });
    return result;
  };
  const work = directory("work");
  const temp = directory("temp");
  const system = directory("system");
  const junction = (name: string, target: string) => {
    const alias = path.join(root, name);
    // Junction creation does not require Windows developer mode. Setup failures
    // must fail these tests, not turn missing Windows coverage into a skip.
    fs.symlinkSync(target, alias, "junction");
    return alias;
  };
  const params = {
    config: {
      containment: "processcontainer" as const,
      network: "none" as const,
      timeoutSeconds: 10,
      debug: false,
    },
    baseline: {
      process: { timeoutSeconds: 10 },
      configuredPaths: {
        readonlyPaths: [] as { path: string; sources: string[] }[],
        readwritePaths: [] as { path: string; sources: string[] }[],
      },
    },
    baselineContext: {
      projectDir: work,
      hostEnv: { SystemRoot: system, ProgramFiles: system, "ProgramFiles(x86)": system },
    },
    containerId: "mxc-physical-overlap-test",
    command: "cmd.exe",
    args: ["/c", "echo unused"],
    sandboxTempDir: temp,
    workdir: work,
    workspace: resolveMxcWorkspaceContext({ workdir: work, workspaceAccess: "none" }),
    env: {},
  };
  const grants = (readonlyPaths: string[], readwritePaths: string[]) => {
    params.baseline.configuredPaths = {
      readonlyPaths: readonlyPaths.map((value) => ({ path: value, sources: ["test policy"] })),
      readwritePaths: readwritePaths.map((value) => ({ path: value, sources: ["test policy"] })),
    };
  };
  const protectedVirtualSkills = (workdir: string) => {
    const skillsWorkspaceDir = directory("materialized");
    directory("materialized", "skills");
    params.workdir = workdir;
    params.workspace = resolveMxcWorkspaceContext({
      workdir,
      agentWorkspaceDir: work,
      skillsWorkspaceDir,
      workspaceAccess: "rw",
    });
    return path.join(workdir, ".openclaw", "sandbox-skills", "skills");
  };
  return { root, directory, junction, params, grants, protectedVirtualSkills };
}

describe.runIf(process.platform === "win32")("MXC physical overlap admission", () => {
  test.each(["equal", "writable ancestor", "readonly ancestor", "readonly alias"])(
    "rejects lexically disjoint junction grants: %s",
    (topology) => {
      const f = fixture();
      const target = f.directory("target");
      const nested = f.directory("target", "nested");
      const alias = f.junction("alias", target);
      const readonly =
        topology === "readonly alias" ? alias : topology === "writable ancestor" ? nested : target;
      const writable =
        topology === "readonly alias"
          ? target
          : topology === "readonly ancestor"
            ? path.join(alias, "nested")
            : alias;
      f.grants([readonly], [writable]);
      expect(() => buildMxcContainerConfig(f.params)).toThrow(
        `MXC readwrite path ${writable} overlaps read-only path ${readonly}.`,
      );
    },
  );

  test("retains lexical rejection when a nested junction physically points elsewhere", () => {
    const f = fixture();
    const writable = f.directory("writable");
    const target = f.directory("elsewhere");
    const readonly = f.junction(path.join("writable", "readonly"), target);
    f.grants([readonly], [writable]);
    expect(() => buildMxcContainerConfig(f.params)).toThrow("overlaps read-only");
  });

  test("rejects a missing protected virtual suffix beneath an aliased writable ancestor", () => {
    const f = fixture();
    const target = f.directory("virtual-target");
    const alias = f.junction("virtual-alias", target);
    const protectedPath = f.protectedVirtualSkills(alias);
    f.grants([], [target]);
    expect(fs.existsSync(protectedPath)).toBe(false);
    expect(() => buildMxcContainerConfig(f.params)).toThrow(
      `MXC readwrite path ${target} overlaps read-only path ${protectedPath}.`,
    );
  });

  test("accepts disjoint physical grants without rewriting lexical paths or deduping aliases", () => {
    const f = fixture();
    const readonly = f.directory("readonly");
    const writable = f.directory("writable");
    const readonlyAlias = f.junction("readonly-alias", readonly);
    const writableAlias = f.junction("writable-alias", writable);
    f.grants([readonlyAlias, readonly, readonlyAlias], [writableAlias, writable, writableAlias]);
    const config = buildMxcContainerConfig(f.params);
    expect(config.filesystem?.readonlyPaths).toEqual([
      f.params.workdir,
      f.params.baselineContext.hostEnv.ProgramFiles,
      readonlyAlias,
      readonly,
    ]);
    expect(config.filesystem?.readwritePaths).toEqual([
      f.params.sandboxTempDir,
      writableAlias,
      writable,
    ]);
  });

  test("does not cache physical targets between admissions", () => {
    const f = fixture();
    const readonly = f.directory("readonly");
    const writable = f.directory("writable");
    const alias = f.junction("alias", writable);
    f.grants([readonly], [alias]);
    expect(() => buildMxcContainerConfig(f.params)).not.toThrow();
    fs.unlinkSync(alias);
    fs.symlinkSync(readonly, alias, "junction");
    expect(() => buildMxcContainerConfig(f.params)).toThrow("overlaps read-only");
  });

  test.each(["ELOOP", "ENOTDIR"])("fails closed on a protected path resolution %s", (code) => {
    const f = fixture();
    const invalid = path.join(f.root, "invalid");
    if (code === "ELOOP") {
      f.junction("invalid", invalid);
    } else {
      fs.writeFileSync(invalid, "not a directory");
    }
    const protectedPath = f.protectedVirtualSkills(invalid);
    expect(() => buildMxcContainerConfig(f.params)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(protectedPath),
        cause: expect.objectContaining({ code }),
      }),
    );
  });

  test("fails closed on EACCES instead of falling back to lexical comparison", () => {
    const f = fixture();
    const readonly = f.directory("readonly");
    const writable = f.directory("writable");
    f.grants([readonly], [writable]);
    const lstatSync = fs.lstatSync;
    const error = Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === writable) {
        throw error;
      }
      return Reflect.apply(lstatSync, fs, args);
    });
    expect(() => buildMxcContainerConfig(f.params)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(writable),
        cause: error,
      }),
    );
  });
});
