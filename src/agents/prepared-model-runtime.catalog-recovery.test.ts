// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { PreparedModelRuntimeAuthPublicationOwner } from "./prepared-model-runtime-auth-publication.js";
import {
  advancePreparedModelRuntimeConfig,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch,
} from "./prepared-model-runtime.js";
import { capturePreparedModelRuntimeGeneration } from "./prepared-model-runtime.lifecycle.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime catalog recovery", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime-catalog-recovery" });
    await resetPreparedModelRuntimeHarness(state);
    mocks.configuredAgentDirs.set("default", "/tmp/unused-agent");
    mocks.configuredAgentDirs.set("secondary", "/tmp/configured-secondary");
    mocks.configuredAgentDirs.set("tertiary", "/tmp/configured-tertiary");
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it("drains queued auth mutations before rebuilding reply dispatch", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }
    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    await expect(recovery).resolves.toBe(true);

    await expect(prepareModelRuntimeSnapshot(defaultInput)).resolves.not.toBe(initialDefault);
    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "secondary",
        config,
        agentDir: "/tmp/configured-secondary",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-secondary",
      }),
    ).resolves.toMatchObject({ agentId: "secondary" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).resolves.toMatchObject({ agentId: "secondary" });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4);
  });

  it("publishes an auth mutation queued immediately after the recovery commit", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    let injectedMutation = false;
    const resolveSpy = vi
      .spyOn(PreparedModelRuntimeAuthPublicationOwner.prototype, "resolve")
      .mockImplementation(function (this: PreparedModelRuntimeAuthPublicationOwner, ...args) {
        resolveSpy.mockRestore();
        const resolved = this.resolve(...args);
        if (!injectedMutation) {
          injectedMutation = true;
          queueMicrotask(() => {
            mocks.mutationListener?.({
              agentDir: "/tmp/unused-agent",
              affectsInheritedStores: false,
            });
          });
        }
        return resolved;
      });

    try {
      const recovery =
        replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
      mocks.mutationListener?.({
        agentDir: "/tmp/configured-secondary",
        affectsInheritedStores: false,
      });
      await expect(recovery).resolves.toBe(true);

      await expect(prepareModelRuntimeSnapshot(defaultInput)).resolves.not.toBe(initialDefault);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ agentId: "default" });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(6);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("continues queued recovery after a model-neutral config stamp", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    let signalAuthBuildStarted: (() => void) | undefined;
    const authBuildStarted = new Promise<void>((resolve) => {
      signalAuthBuildStarted = resolve;
    });
    let releaseAuthBuild: (() => void) | undefined;
    const authBuildBlocked = new Promise<void>((resolve) => {
      releaseAuthBuild = resolve;
    });
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
      signalAuthBuildStarted?.();
      await authBuildBlocked;
      return { agentDir: String(args[1]), wrote: false };
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    await authBuildStarted;

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    const stampedConfig = { logging: { level: "debug" as const } };
    advancePreparedModelRuntimeConfig(stampedConfig);
    releaseAuthBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default", config: stampedConfig });
  });

  it("continues recovery when a config stamp replaces the snapshot before async dispatch", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(initialDefault);
    expect(owner).toBeDefined();
    if (!owner) {
      throw new Error("default prepared model runtime snapshot had no owner");
    }
    const generation = owner.generation;

    const stampedConfig = { logging: { level: "debug" as const } };
    advancePreparedModelRuntimeConfig(stampedConfig);
    expect(resolvePreparedModelRuntimeOwnerBySnapshot(initialDefault)).toBeUndefined();

    await expect(
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault, [
        owner,
        generation,
      ]),
    ).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default", config: stampedConfig });
  });

  it("continues queued recovery after auth rekeys its configured owner", async () => {
    mocks.configuredAgentIds = ["secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const secondaryInput = {
      agentId: "secondary",
      config,
      agentDir: "/tmp/configured-secondary",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-secondary",
    };
    const initialSecondary = getPreparedModelRuntimeSnapshot(secondaryInput);
    expect(initialSecondary).toBeDefined();
    if (!initialSecondary) {
      throw new Error("secondary prepared model runtime owner was not published");
    }

    let signalAuthBuildStarted: (() => void) | undefined;
    const authBuildStarted = new Promise<void>((resolve) => {
      signalAuthBuildStarted = resolve;
    });
    let releaseAuthBuild: (() => void) | undefined;
    const authBuildBlocked = new Promise<void>((resolve) => {
      releaseAuthBuild = resolve;
    });
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
      signalAuthBuildStarted?.();
      await authBuildBlocked;
      return { agentDir: String(args[1]), wrote: false };
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/unused-agent",
      affectsInheritedStores: false,
    });
    await authBuildStarted;

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialSecondary);
    mocks.configuredAgentDirs.set("default", "/tmp/rekeyed-default-auth");
    mocks.mutationListener?.({
      agentDir: "/tmp/unused-agent",
      affectsInheritedStores: false,
    });
    releaseAuthBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).resolves.toMatchObject({ agentId: "secondary" });
  });

  it("preserves unfinished auth components when recovery adopts a running drain", async () => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    let signalAuthBuildStarted: (() => void) | undefined;
    const authBuildStarted = new Promise<void>((resolve) => {
      signalAuthBuildStarted = resolve;
    });
    let releaseAuthBuild: (() => void) | undefined;
    const authBuildBlocked = new Promise<void>((resolve) => {
      releaseAuthBuild = resolve;
    });
    const authError = new Error("secondary auth failed before recovery adoption");
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      signalAuthBuildStarted?.();
      await authBuildBlocked;
      throw authError;
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-tertiary",
      affectsInheritedStores: false,
    });
    await authBuildStarted;

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    releaseAuthBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("prepared reply dispatch runtime owner was not published for secondary");
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "tertiary" }),
    ).resolves.toMatchObject({ agentId: "tertiary" });
  });

  it("publishes recovered dispatch while an unrelated owner remains degraded", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    let signalWarning: (() => void) | undefined;
    const warningReported = new Promise<void>((resolve) => {
      signalWarning = resolve;
    });
    mocks.warn.mockImplementationOnce(() => signalWarning?.());
    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(new Error("secondary auth failed"));
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    await warningReported;
    expect(mocks.warn).toHaveBeenCalledOnce();

    await expect(
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault),
    ).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("prepared reply dispatch runtime owner was not published for secondary");
  });

  it("restores recovered dispatch when an adopted sibling refresh fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }
    let signalRecoveryBuildStarted: (() => void) | undefined;
    const recoveryBuildStarted = new Promise<void>((resolve) => {
      signalRecoveryBuildStarted = resolve;
    });
    let releaseRecoveryBuild: (() => void) | undefined;
    const recoveryBuildBlocked = new Promise<void>((resolve) => {
      releaseRecoveryBuild = resolve;
    });
    const siblingError = new Error("adopted secondary auth failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async (...args: unknown[]) => {
        signalRecoveryBuildStarted?.();
        await recoveryBuildBlocked;
        return { agentDir: String(args[1]), wrote: false };
      })
      .mockImplementationOnce(async () => {
        mocks.mutationListener?.({
          agentDir: "/tmp/configured-tertiary",
          affectsInheritedStores: false,
        });
        throw siblingError;
      });

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    await recoveryBuildStarted;
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });
    releaseRecoveryBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("prepared reply dispatch runtime owner was not published for secondary");
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "tertiary" }),
    ).resolves.toMatchObject({ agentId: "tertiary" });
  });

  it.each([
    ["recovery first", ["secondary", "tertiary"]],
    ["sibling first", ["tertiary", "secondary"]],
  ])("settles an independent owner when adopted auth fails for the %s", async (_label, order) => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const secondaryInput = {
      agentId: "secondary",
      config,
      agentDir: "/tmp/configured-secondary",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-secondary",
    };
    const initialSecondary = getPreparedModelRuntimeSnapshot(secondaryInput);
    expect(initialSecondary).toBeDefined();
    if (!initialSecondary) {
      throw new Error("secondary prepared model runtime owner was not published");
    }

    let signalRecoveryBuildStarted: (() => void) | undefined;
    const recoveryBuildStarted = new Promise<void>((resolve) => {
      signalRecoveryBuildStarted = resolve;
    });
    let releaseRecoveryBuild: (() => void) | undefined;
    const recoveryBuildBlocked = new Promise<void>((resolve) => {
      releaseRecoveryBuild = resolve;
    });
    const authError = new Error("adopted default auth failed");
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
      signalRecoveryBuildStarted?.();
      await recoveryBuildBlocked;
      return { agentDir: String(args[1]), wrote: false };
    });
    for (const agentId of order) {
      mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
        if (agentId === "secondary") {
          throw authError;
        }
        return { agentDir: String(args[1]), wrote: false };
      });
    }

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialSecondary);
    await recoveryBuildStarted;
    for (const agentId of order) {
      mocks.mutationListener?.({
        agentDir:
          agentId === "secondary" ? "/tmp/configured-secondary" : "/tmp/configured-tertiary",
        affectsInheritedStores: false,
      });
    }
    releaseRecoveryBuild?.();

    await expect(recovery).rejects.toBe(authError);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("prepared reply dispatch runtime owner was not published for secondary");
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "tertiary" }),
    ).resolves.toMatchObject({ agentId: "tertiary" });
  });

  it("keeps a completed owner pending when later auth work links it to failed recovery", async () => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const secondaryInput = {
      agentId: "secondary",
      config,
      agentDir: "/tmp/configured-secondary",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-secondary",
    };
    const initialSecondary = getPreparedModelRuntimeSnapshot(secondaryInput);
    expect(initialSecondary).toBeDefined();
    if (!initialSecondary) {
      throw new Error("secondary prepared model runtime owner was not published");
    }

    const authError = new Error("adopted secondary auth failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async (...args: unknown[]) => ({
        agentDir: String(args[1]),
        wrote: false,
      }))
      .mockImplementationOnce(async (...args: unknown[]) => ({
        agentDir: String(args[1]),
        wrote: false,
      }))
      .mockImplementationOnce(async () => {
        mocks.mutationListener?.({ affectsInheritedStores: true });
        throw authError;
      });

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialSecondary);
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-tertiary",
      affectsInheritedStores: false,
    });
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-secondary",
      affectsInheritedStores: false,
    });

    await expect(recovery).rejects.toBe(authError);
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "tertiary" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for tertiary",
    );
  });

  it("settles adopted auth work and healthy readers when recovery fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }
    const initialOwner = resolvePreparedModelRuntimeOwnerBySnapshot(initialDefault);
    expect(initialOwner).toBeDefined();
    if (!initialOwner) {
      throw new Error("default prepared model runtime owner was not retained");
    }
    const retirement = capturePreparedModelRuntimeGeneration(initialOwner);
    expect(getPreparedModelRuntimeTestApi().hasPreparedPluginPublicationForTest(initialOwner)).toBe(
      true,
    );

    let signalRecoveryBuildStarted: (() => void) | undefined;
    const recoveryBuildStarted = new Promise<void>((resolve) => {
      signalRecoveryBuildStarted = resolve;
    });
    let releaseRecoveryBuild: (() => void) | undefined;
    const recoveryBuildBlocked = new Promise<void>((resolve) => {
      releaseRecoveryBuild = resolve;
    });
    const recoveryError = new Error("default recovery failed");
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      signalRecoveryBuildStarted?.();
      await recoveryBuildBlocked;
      mocks.mutationListener?.({
        agentDir: "/tmp/configured-secondary",
        affectsInheritedStores: false,
      });
      throw recoveryError;
    });

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    await recoveryBuildStarted;
    try {
      expect(retirement.aborted).toBe(true);
      expect(
        getPreparedModelRuntimeTestApi().hasPreparedPluginPublicationForTest(initialOwner),
      ).toBe(false);
      const healthyDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" });
      const healthyRuntime = prepareModelRuntimeSnapshot({
        agentId: "secondary",
        config,
        agentDir: "/tmp/configured-secondary",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-secondary",
      });
      releaseRecoveryBuild?.();

      await expect(recovery).rejects.toBe(recoveryError);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).rejects.toThrow("prepared reply dispatch runtime owner was not published for default");
      await expect(healthyDispatch).resolves.toMatchObject({ agentId: "secondary" });
      await expect(healthyRuntime).resolves.toMatchObject({ agentId: "secondary" });
    } finally {
      releaseRecoveryBuild?.();
    }
  });

  it("defers to a config replacement that supersedes recovery", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    let signalRecoveryBuildStarted: (() => void) | undefined;
    const recoveryBuildStarted = new Promise<void>((resolve) => {
      signalRecoveryBuildStarted = resolve;
    });
    let releaseRecoveryBuild: (() => void) | undefined;
    const recoveryBuildBlocked = new Promise<void>((resolve) => {
      releaseRecoveryBuild = resolve;
    });
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      signalRecoveryBuildStarted?.();
      await recoveryBuildBlocked;
      return { agentDir: "/tmp/unused-agent", wrote: false };
    });

    const recovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault);
    await recoveryBuildStarted;
    const replacementConfig = { gateway: { mode: "local" as const } };
    const configReplacement = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    releaseRecoveryBuild?.();

    await expect(recovery).resolves.toBe(true);
    await expect(configReplacement).resolves.toBeUndefined();
    await expect(
      prepareModelRuntimeSnapshot({ ...defaultInput, config: replacementConfig }),
    ).resolves.toMatchObject({ config: replacementConfig });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: replacementConfig });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("does not report recovery through an unrelated degraded replacement", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }

    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
    mocks.configuredAgentIds = ["default", "secondary"];
    let releaseSecondaryBuild: (() => void) | undefined;
    const secondaryBuildBlocked = new Promise<void>((resolve) => {
      releaseSecondaryBuild = resolve;
    });
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      await secondaryBuildBlocked;
      return { agentDir: "/tmp/configured-secondary", wrote: false };
    });
    let signalSecondaryPublished: (() => void) | undefined;
    const secondaryPublished = new Promise<void>((resolve) => {
      signalSecondaryPublished = resolve;
    });
    const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
      if (
        event.phase === "published" &&
        getPreparedModelRuntimeSnapshot({
          agentId: "secondary",
          config,
          agentDir: "/tmp/configured-secondary",
          inheritedAuthDir: "/tmp/unused-agent",
          workspaceDir: "/tmp/workspace-secondary",
        })
      ) {
        signalSecondaryPublished?.();
      }
    });

    try {
      const degradedRefresh = refreshPreparedModelRuntimeSnapshots(config, {
        agentIds: new Set(["secondary"]),
        catalogMode: "static",
        gatewayLifecycle: true,
        startup: true,
      });
      await expect(degradedRefresh).resolves.toBeUndefined();
      await expect(
        replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialDefault),
      ).resolves.toBe(false);

      releaseSecondaryBuild?.();
      await secondaryPublished;
      expect(
        getPreparedModelRuntimeSnapshot({
          agentId: "secondary",
          config,
          agentDir: "/tmp/configured-secondary",
          inheritedAuthDir: "/tmp/unused-agent",
          workspaceDir: "/tmp/workspace-secondary",
        }),
      ).toMatchObject({ agentId: "secondary" });
      expect(getPreparedModelRuntimeSnapshot(defaultInput)).not.toBe(initialDefault);
    } finally {
      unsubscribe();
    }
  });

  it("recovers a captured generation after a newer unrelated replacement fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary", "tertiary"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const defaultInput = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    const initialDefault = getPreparedModelRuntimeSnapshot(defaultInput);
    expect(initialDefault).toBeDefined();
    if (!initialDefault) {
      throw new Error("default prepared model runtime owner was not published");
    }
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(initialDefault);
    expect(owner).toBeDefined();
    if (!owner) {
      throw new Error("default prepared model runtime snapshot had no owner");
    }
    const generation = owner.generation;
    const secondaryInput = {
      agentId: "secondary",
      config,
      agentDir: "/tmp/configured-secondary",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-secondary",
    };
    const initialSecondary = getPreparedModelRuntimeSnapshot(secondaryInput);
    expect(initialSecondary).toBeDefined();
    if (!initialSecondary) {
      throw new Error("secondary prepared model runtime owner was not published");
    }

    let signalSecondaryBuildStarted: (() => void) | undefined;
    const secondaryBuildStarted = new Promise<void>((resolve) => {
      signalSecondaryBuildStarted = resolve;
    });
    let releaseSecondaryBuild: (() => void) | undefined;
    const secondaryBuildBlocked = new Promise<void>((resolve) => {
      releaseSecondaryBuild = resolve;
    });
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      signalSecondaryBuildStarted?.();
      await secondaryBuildBlocked;
      return { agentDir: "/tmp/configured-secondary", wrote: false };
    });
    const newerReplacementError = new Error("tertiary replacement failed");
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      throw newerReplacementError;
    });

    const secondaryRecovery =
      replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(initialSecondary);
    await secondaryBuildStarted;
    const stampedConfig = { logging: { level: "debug" as const } };
    advancePreparedModelRuntimeConfig(stampedConfig);
    expect(resolvePreparedModelRuntimeOwnerBySnapshot(initialDefault)).toBeUndefined();

    const defaultRecovery = replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(
      initialDefault,
      [owner, generation],
    );
    let newerReplacement: Promise<void> | undefined;
    const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published" && !newerReplacement) {
        newerReplacement = refreshPreparedModelRuntimeSnapshots(stampedConfig, {
          agentIds: new Set(["tertiary"]),
          gatewayLifecycle: true,
        });
        void newerReplacement.catch(() => {});
      }
    });

    try {
      releaseSecondaryBuild?.();
      await expect(secondaryRecovery).rejects.toBe(newerReplacementError);
      await expect(newerReplacement).rejects.toBe(newerReplacementError);
      await expect(defaultRecovery).resolves.toBe(true);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ agentId: "default", config: stampedConfig });
    } finally {
      unsubscribe();
    }
  });
});
