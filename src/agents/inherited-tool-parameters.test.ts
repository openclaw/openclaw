import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { prepareDelegatedToolParameterTarget } from "./delegated-tool-parameter-target.js";
import {
  applyDelegatedToolParameters,
  areDelegatedToolParametersCompatible,
  captureDelegatedToolParameters,
  emptyDelegatedToolParameterPolicy,
} from "./inherited-tool-parameters.js";
import { parseDelegatedToolParameterPolicy } from "./inherited-tool-parameters.schema.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const applicability = {
  exec: true,
  fileTools: true,
  fileWrites: true,
  applyPatch: true,
  sandbox: true,
};

function prepare(
  config: Parameters<typeof prepareDelegatedToolParameterTarget>[0]["config"] = {},
  modelId = "available",
) {
  return prepareDelegatedToolParameterTarget({
    config,
    agentId: "worker",
    sessionEntry: null,
    sessionPermissionPolicy: undefined,
    rootIsWorkspace: true,
    elevated: null,
    sandbox: { sandboxed: false, sandboxRequired: false },
    modelProvider: "synthetic",
    modelId,
  });
}

describe("delegated parameter owners", () => {
  it("relocates file restrictions to the receiver workspace and retains configured model eligibility", async () => {
    const root = temporary.make("delegated-files-");
    const workspace = path.join(root, "receiver");
    await fs.mkdir(workspace);
    const source = prepare(
      {
        tools: {
          fs: { workspaceOnly: true },
          exec: { applyPatch: { allowModels: ["synthetic/available"] } },
        },
      },
      "currently-unavailable",
    );
    expect(source.fileTools.applyPatchEnabled).toBe(false);
    const encodedPolicy = JSON.stringify(captureDelegatedToolParameters(source));
    const policy = parseDelegatedToolParameterPolicy(JSON.parse(encodedPolicy));
    const receiver = prepare({
      tools: { fs: { workspaceOnly: false }, exec: { applyPatch: { workspaceOnly: false } } },
    });
    const applied = applyDelegatedToolParameters({ ...receiver, policy, applicability });
    const tools = createCoreCodingTools({
      codingRoot: workspace,
      containmentRoot: workspace,
      includeBaseCodingTools: true,
      shellTools: "patch-only",
      ...applied.fileTools,
      execDefaults: applied.exec,
      processDefaults: {},
    });
    const patch = tools.find((tool) => tool.name === "apply_patch");
    expect(patch).toBeDefined();
    if (!patch) {
      throw new Error("Expected eligible receiver patch tool");
    }
    await patch.execute("inside", {
      input: "*** Begin Patch\n*** Add File: result.txt\n+receiver result\n*** End Patch",
    });
    await expect(fs.readFile(path.join(workspace, "result.txt"), "utf8")).resolves.toBe(
      "receiver result\n",
    );
    await expect(
      patch.execute("outside", {
        input: "*** Begin Patch\n*** Add File: ../outside.txt\n+outside\n*** End Patch",
      }),
    ).rejects.toThrow(/sandbox root/);
    await expect(fs.stat(path.join(root, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const readOnly = captureDelegatedToolParameters(
      prepareDelegatedToolParameterTarget({
        config: {},
        agentId: "source",
        sessionEntry: null,
        sessionPermissionPolicy: { root: workspace, mode: "read-only" },
        rootIsWorkspace: true,
        elevated: null,
        sandbox: { sandboxed: false, sandboxRequired: false },
        modelProvider: "synthetic",
        modelId: "available",
      }),
    );
    const narrowed = applyDelegatedToolParameters({ ...receiver, policy: readOnly, applicability });
    const readOnlyTools = createCoreCodingTools({
      codingRoot: workspace,
      containmentRoot: workspace,
      includeBaseCodingTools: true,
      shellTools: "patch-only",
      ...narrowed.fileTools,
      execDefaults: narrowed.exec,
      processDefaults: {},
    });
    expect(readOnlyTools.some((tool) => ["write", "edit", "apply_patch"].includes(tool.name))).toBe(
      false,
    );
    const read = readOnlyTools.find((tool) => tool.name === "read");
    expect(read).toBeDefined();
    if (!read) {
      throw new Error("Expected receiver read tool");
    }
    expect((await read.execute("read", { path: "result.txt" })).content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("receiver result") }),
    );
  });

  it("checks sandbox requirements before acceptance without changing either configuration", () => {
    const source = prepare({
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "none", docker: { network: "none" } },
        },
      },
    });
    source.sandbox.sandboxed = true;
    const policy = captureDelegatedToolParameters(source);
    const receiver = prepare({
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "none", docker: { network: "bridge" } },
        },
      },
    });
    receiver.sandbox.sandboxed = true;
    expect(() => applyDelegatedToolParameters({ ...receiver, policy, applicability })).toThrow(
      /sandbox requirements/,
    );
    expect(receiver.sandbox.config.docker.network).toBe("bridge");
    expect(source.sandbox.config.docker.network).toBe("none");
    receiver.sandbox.config.docker.network = "none";
    expect(() =>
      applyDelegatedToolParameters({ ...receiver, policy, applicability }),
    ).not.toThrow();
    receiver.sandbox.config.workspaceAccess = "ro";
    expect(() => applyDelegatedToolParameters({ ...receiver, policy, applicability })).toThrow(
      /sandbox requirements/,
    );
  });

  it("does not transfer resource bindings or restrict a child whose configured policy excludes the affected action", () => {
    const source = prepare({ tools: { exec: { host: "node", node: "source-node" } } });
    const policy = captureDelegatedToolParameters(source);
    expect(JSON.stringify(policy)).not.toContain("source-node");
    const target = prepare();
    expect(() => applyDelegatedToolParameters({ ...target, policy, applicability })).toThrow(
      /exec-node-binding/,
    );
    expect(() =>
      applyDelegatedToolParameters({
        ...target,
        policy,
        applicability: { ...applicability, exec: false },
      }),
    ).not.toThrow();
  });

  it("distinguishes explicit approval from auto review and accepts a stricter receiver", () => {
    const source = captureDelegatedToolParameters(prepare({ tools: { exec: { mode: "ask" } } }));
    const auto = captureDelegatedToolParameters(prepare({ tools: { exec: { mode: "auto" } } }));
    const deny = captureDelegatedToolParameters(prepare({ tools: { exec: { mode: "deny" } } }));
    expect(areDelegatedToolParametersCompatible(source, auto, applicability).compatible).toBe(
      false,
    );
    expect(areDelegatedToolParametersCompatible(source, deny, applicability).compatible).toBe(true);
    expect(areDelegatedToolParametersCompatible(auto, source, applicability).compatible).toBe(
      false,
    );
    expect(
      areDelegatedToolParametersCompatible(auto, source, applicability, source).compatible,
    ).toBe(true);
  });

  it("deduplicates equivalent inherited predicates without flattening different restrictions", () => {
    const source = captureDelegatedToolParameters(
      prepare({ tools: { exec: { mode: "ask" }, fs: { workspaceOnly: true } } }),
    );
    const distinct = captureDelegatedToolParameters(
      prepare({ tools: { exec: { mode: "allowlist" } } }),
    );
    const nested = parseDelegatedToolParameterPolicy({
      fileTools: Array.from({ length: 65 }, () => source.fileTools[0]),
      exec: [...Array.from({ length: 65 }, () => source.exec[0]), ...distinct.exec],
      sandbox: [],
      unsupported: [],
    });
    expect(nested.fileTools).toHaveLength(1);
    expect(nested.exec).toHaveLength(2);
    const applied = applyDelegatedToolParameters({ ...prepare(), policy: nested, applicability });
    expect(applied.exec.ask).toBe("on-miss");
    expect(applied.fileTools.workspaceOnly).toBe(true);
  });

  it("rejects malformed persisted predicates rather than accepting an empty policy", () => {
    const empty = emptyDelegatedToolParameterPolicy();
    expect(() =>
      parseDelegatedToolParameterPolicy({ ...empty, exec: [{ security: "allowlist" }] }),
    ).toThrow(/Invalid inherited/);
    expect(() => parseDelegatedToolParameterPolicy({ ...empty, hiddenPermission: true })).toThrow(
      /Invalid inherited/,
    );
    expect(parseDelegatedToolParameterPolicy(empty)).toEqual(empty);
  });
});
