import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { hasModelFallbackStop, resolveModelFallbackError } from "../failover-error.js";
import { CliAuthProfilePreparationError } from "./auth-profile-preparation-error.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import * as toolAuthority from "./tool-authority.js";

let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

beforeEach(() => {
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    loadManifestModelCatalog: () => [],
  });
  fixture = createCliRunnerPrepareFixture((params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
  });
});

afterEach(async () => {
  await fixture.cleanup();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each(["error", "frozen", "auth", "undefined-required", "undefined-clean"] as const)(
  "preserves preparation failure across deferred backend cleanup (%s)",
  async (scenario) => {
    const original =
      scenario === "auth"
        ? new CliAuthProfilePreparationError({
            message: "selected profile preparation failed",
            profileId: "fixture-profile",
            provider: "settings-cli",
            agentDir: fixture.session.dir,
          })
        : scenario === "frozen"
          ? Object.freeze(new Error("preparation refused"))
          : scenario === "error"
            ? new Error("preparation refused")
            : undefined;
    const cleanupFails = scenario !== "undefined-clean";
    const entered = createDeferred();
    const held = createDeferred();
    let prepared = false;
    const backend: CliBackendPlugin & { pluginId: string } = {
      id: "settings-cli",
      pluginId: "settings-plugin",
      bundleMcp: false,
      prepareExecution: async () => {
        prepared = true;
        return {
          cleanup: async () => {
            entered.resolve();
            await held.promise;
          },
        };
      },
      config: {
        command: "settings-cli",
        args: ["--print"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
    let authorityDisposed = false;
    const captureAuthority = toolAuthority.captureCliRunToolAuthority;
    const capture = vi
      .spyOn(toolAuthority, "captureCliRunToolAuthority")
      .mockImplementation((...args) => {
        const authority = captureAuthority(...args);
        const dispose = authority[Symbol.dispose].bind(authority);
        authority[Symbol.dispose] = () => {
          authorityDisposed = true;
          dispose();
        };
        return authority;
      });
    let finished = false;
    const preparation = fixture
      .prepare({
        provider: "settings-cli",
        assertCurrent: () => {
          if (prepared) {
            // oxlint-disable-next-line typescript/only-throw-error -- Exercise undefined authority refusal without normalizing it in the fixture.
            throw original;
          }
        },
      })
      .finally(() => {
        finished = true;
      });
    const failure = preparation.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, preparation, "backend cleanup was skipped");
      expect(finished).toBe(false);
      expect(capture).toHaveBeenCalledOnce();
      expect(authorityDisposed).toBe(false);
      if (cleanupFails) {
        held.reject(new Error("backend cleanup failed"));
      } else {
        held.resolve();
      }
      const error = await failure;
      expect(authorityDisposed).toBe(true);
      if (original instanceof Error || !cleanupFails) {
        expect(error).toBe(original);
      } else {
        expect(error).toEqual(new Error("undefined"));
      }
      expect(hasModelFallbackStop(error)).toBe(cleanupFails);
      if (cleanupFails) {
        expect(resolveModelFallbackError(error)).toEqual({ kind: "terminal", error });
      }
    } finally {
      held.resolve();
      await failure;
    }
  },
);
