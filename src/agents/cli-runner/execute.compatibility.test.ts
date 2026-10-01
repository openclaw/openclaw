import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withInstallationTarget } from "../../infra/installation-target-context.js";
import type {
  CliBackendExecute,
  CliBackendModelCatalogResult,
} from "../../plugins/cli-backend.types.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executeDeps } from "./execute-deps.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import { withCliBackendMaintenance } from "./runtime-maintenance.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const modelId = "fixture-new-model";
let root: string;
let originalInvokeNode = executeDeps.invokeNodeClaudeCliRun;

beforeEach(() => {
  root = tempDirs.make("cli-compatibility-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "config.json"));
  originalInvokeNode = executeDeps.invokeNodeClaudeCliRun;
  supervisorSpawnMock.mockReset();
});

afterEach(async () => {
  executeDeps.invokeNodeClaudeCliRun = originalInvokeNode;
  supervisorSpawnMock.mockReset();
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function contextFor(kind: "process" | "plugin" | "node") {
  const context = buildPreparedCliRunContext({
    workspaceDir: root,
    model: modelId,
    backend: {
      command: process.execPath,
      args: [],
      output: kind === "process" ? "text" : "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      systemPromptFileArg: undefined,
      sessionArgs: undefined,
      modelArg: undefined,
    },
  });
  context.backendResolved.bundleMcp = false;
  context.params.sessionFile = path.join(root, "session.jsonl");
  const plugin = vi.fn<CliBackendExecute>(async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: context.cliRuntimeVersion ?? "unverified",
    };
  });
  context.executionTarget =
    kind === "plugin"
      ? { kind, execute: plugin }
      : kind === "node"
        ? { kind, placement: { nodeId: "private-fixture-node" } }
        : { kind };
  return { context, plugin };
}

function ready(): CliBackendModelCatalogResult {
  return { models: { [modelId]: { available: true } }, runtimeVersion: "2.1.286" };
}

describe("CLI compatibility at the execution boundary", () => {
  it("defers busy installation mutation while an active plugin turn completes", async ({
    signal,
  }) => {
    const { context } = contextFor("plugin");
    const entered = createDeferred();
    const finish = createDeferred();
    let mutationRan = false;
    context.executionTarget = {
      kind: "plugin",
      async *execute() {
        entered.resolve();
        await finish.promise;
        expect(mutationRan).toBe(false);
        yield { type: "result", result: "active turn completed" };
      },
    };
    const run = executePreparedCliRun(context);
    let maintenance: Promise<void | undefined> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, run, "Turn did not start"),
        signal,
      );
      maintenance = withCliBackendMaintenance(
        context.backendResolved.id,
        signal,
        () => {},
        async () => {
          mutationRan = true;
        },
      );
      await maintenance;
      expect(mutationRan).toBe(false);
      finish.resolve();
      await expect(run).resolves.toMatchObject({ text: "active turn completed" });
      await withCliBackendMaintenance(
        context.backendResolved.id,
        signal,
        () => {},
        async () => {
          mutationRan = true;
        },
      );
      expect(mutationRan).toBe(true);
    } finally {
      finish.resolve();
      await Promise.allSettled([run, maintenance]);
    }
  });

  it.each(["process", "plugin"] as const)(
    "refuses incompatible %s execution before a prompt is sent",
    async (kind) => {
      const { context, plugin } = contextFor(kind);
      context.backendResolved.prepareModelCatalog = async () => ({
        models: {
          [modelId]: { available: false, reason: "Update could not satisfy the model requirement" },
        },
      });
      await expect(executePreparedCliRun(context)).rejects.toThrow(
        "Update could not satisfy the model requirement",
      );
      expect(plugin).not.toHaveBeenCalled();
      expect(supervisorSpawnMock).not.toHaveBeenCalled();
    },
  );

  it.each(["process", "plugin"] as const)(
    "prepares the verified runtime version before the %s launch",
    async (kind) => {
      const { context } = contextFor(kind);
      const prepare = vi.fn(async () => ready());
      context.backendResolved.prepareModelCatalog = prepare;
      supervisorSpawnMock.mockImplementation(async () =>
        createManagedRun({
          ...createSuccessfulProcessExit(),
          stdout: context.cliRuntimeVersion ?? "unverified",
        }),
      );
      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "2.1.286" });
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          modelIds: [modelId],
          cwd: root,
          reason: "routine",
        }),
      );
    },
  );

  it("dispatches a paired-node run without maintaining the Gateway's CLI", async () => {
    const { context } = contextFor("node");
    const prepare = vi.fn(async () => {
      throw new Error("Gateway installation must not be used for node compatibility");
    });
    context.backendResolved.prepareModelCatalog = prepare;
    const invokeNode = vi.fn<typeof executeDeps.invokeNodeClaudeCliRun>(async (params) => {
      params.onProgress(`${JSON.stringify({ type: "result", result: "node-completed" })}\n`);
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
      };
    });
    executeDeps.invokeNodeClaudeCliRun = invokeNode;
    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "node-completed" });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
  });

  it("keeps maintenance state on the selected diagnosed installation", async () => {
    const { context } = contextFor("plugin");
    const target = {
      stateDir: path.join(root, "diagnosed-state"),
      configPath: path.join(root, "diagnosed-config.json"),
      defaultWorkspaceDir: path.join(root, "diagnosed-workspace"),
    };
    const prepare = vi.fn(async () => ready());
    context.backendResolved.prepareModelCatalog = prepare;
    await expect(
      withInstallationTarget(target, () => executePreparedCliRun(context)),
    ).resolves.toMatchObject({ text: "2.1.286" });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: target.stateDir, HOME: root }),
      }),
    );
    expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(root, "state"));
  });

  it("rechecks authority after awaited compatibility before launching", async ({ signal }) => {
    const { context, plugin } = contextFor("plugin");
    const entered = createDeferred();
    const finish = createDeferred<CliBackendModelCatalogResult>();
    let current = true;
    context.params.assertCurrent = () => {
      if (!current) {
        throw new Error("Run authority expired");
      }
    };
    context.backendResolved.prepareModelCatalog = async () => {
      entered.resolve();
      return finish.promise;
    };
    const run = executePreparedCliRun(context);
    const rejected = expect(run).rejects.toThrow("Run authority expired");
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, run, "Compatibility was not reached"),
        signal,
      );
      current = false;
      finish.resolve(ready());
      await rejected;
      expect(plugin).not.toHaveBeenCalled();
      expect(supervisorSpawnMock).not.toHaveBeenCalled();
    } finally {
      finish.resolve(ready());
      await Promise.allSettled([run, rejected]);
    }
  });
});
