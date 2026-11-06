import fs from "node:fs/promises";
import path from "node:path";
import type {
  BrowserExtensionRegistration,
  BrowserExtensionRequest,
  ExtensionHostSession,
} from "openclaw/plugin-sdk/browser-extension-host";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import { getBrowserControlState, createBrowserControlContext } from "../browser-control-state.js";
import { startBrowserControlServiceFromConfig } from "../control-service.js";
import { type CdpSendFn, withCdpSocket } from "./cdp.helpers.js";
import { getChromeWebSocketEndpoint, isChromeReachable } from "./chrome.js";
import { withChromeProfileLifecycleLock } from "./chrome.profile-lifecycle-lock.js";
import { isLocalManagedProfile } from "./config.js";
import {
  matchesExtensionBrowserEndpoint,
  quarantineExtensionProfile,
} from "./extension-host-state.js";
import { extensionDeclarations, type ExtensionDeclaration } from "./extension-launch-state.js";
import { cachedByCdpUrl, contextStates } from "./pw-session-contracts.js";
import { hasBrowserScreencast } from "./screencast/session.js";
import { runProfileContextOperation } from "./server-context.js";
import type { ProfileContext, ProfileRuntimeState } from "./server-context.types.js";

// This name is resolved only by serialized worker functions, never on the host.
declare const chrome: {
  tabs: { query(query: object): Promise<Array<{ id?: number; url?: string }>> };
};

/**
 * Public `withExclusiveTab` rejection (see the SDK contract): a live screencast or trace
 * observes the profile. Nothing ran, so callers may retry once the observer stops.
 */
class ExtensionTabObservedError extends Error {
  readonly code = "tabObserved";
}

const manifestSchema = z.object({
  manifest_version: z.literal(3),
  version: z.string().regex(/^\d+(?:\.\d+){0,3}$/),
  background: z.object({ service_worker: z.string().min(1) }),
});
const targetsSchema = z.object({
  targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
});
const attachedSchema = z.object({ sessionId: z.string().min(1) });
const evaluationSchema = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.unknown().optional(),
});

function atLeastVersion(actual: string, minimum: string): boolean {
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) {
      return delta > 0;
    }
  }
  return true;
}

/** Validate operator-supplied extension files, without downloading or modifying them. */
async function readDeclaration(
  request: BrowserExtensionRequest,
): Promise<Omit<ExtensionDeclaration, "ownerState">> {
  if (
    !request.profile.trim() ||
    !request.principal.trim() ||
    !/^[a-p]{32}$/.test(request.extension.id)
  ) {
    throw new Error(
      "A profile, person identity, and 32-character Chromium extension id are required.",
    );
  }
  const unpackedPath = await fs.realpath(request.extension.unpackedPath);
  if (unpackedPath.includes(",")) {
    throw new Error(
      "Unpacked extension paths cannot contain commas (Chromium treats them as a list).",
    );
  }
  const manifest = manifestSchema.parse(
    JSON.parse(await fs.readFile(path.join(unpackedPath, "manifest.json"), "utf8")),
  );
  const minimum = request.extension.minimumVersion;
  if (
    minimum &&
    (!/^\d+(?:\.\d+){0,3}$/.test(minimum) || !atLeastVersion(manifest.version, minimum))
  ) {
    throw new Error(
      "The unpacked extension is older than its requested minimum version. Update the operator-managed installation.",
    );
  }
  const worker = new URL(
    manifest.background.service_worker,
    `chrome-extension://${request.extension.id}/`,
  );
  if (worker.protocol !== "chrome-extension:" || worker.hostname !== request.extension.id) {
    throw new Error("Extension service worker must be inside the declared extension.");
  }
  return {
    profile: request.profile,
    principal: request.principal,
    extension: { ...request.extension, unpackedPath },
    version: manifest.version,
    workerPath: worker.href,
  };
}

/** Every task must use the currently resolved managed Chromium profile. */
function assertExtensionProfile(profileCtx: ProfileContext): void {
  if (!isLocalManagedProfile(profileCtx.profile) || profileCtx.profile.engine === "lightpanda") {
    throw new Error(
      "Extension hosts require an OpenClaw-launched local Chromium profile, not attach-only, remote, or existing-session browsers.",
    );
  }
}

/** Declare one person's vetted extension before launching its dedicated managed profile. */
export async function registerBrowserExtension(
  request: BrowserExtensionRequest,
): Promise<BrowserExtensionRegistration> {
  const prepared = await readDeclaration(request);
  const profileName = prepared.profile;
  const state = await startBrowserControlServiceFromConfig();
  if (!state) {
    throw new Error("Browser plugin is disabled. Enable it before requesting a managed extension.");
  }
  const declaration: ExtensionDeclaration = { ...prepared, ownerState: state };
  const profileCtx = createBrowserControlContext().forProfile(profileName);
  assertExtensionProfile(profileCtx);
  let closed = false;
  let closing: Promise<void> | undefined;
  const sessions = new Set<ExtensionHostSession>();
  const assertCurrent = () => {
    if (
      closed ||
      getBrowserControlState() !== state ||
      extensionDeclarations.get(profileName) !== declaration
    ) {
      throw new Error("Browser extension registration is closed or its runtime changed.");
    }
  };
  await withChromeProfileLifecycleLock(profileName, async () => {
    if (extensionDeclarations.has(profileName) || state.profiles.get(profileName)?.running) {
      throw new Error(
        "This browser profile is already owned or running. Stop it before declaring its extension; use one person per profile.",
      );
    }
    if (await isChromeReachable(profileCtx.profile.cdpUrl, 300)) {
      throw new Error(
        "Browser is already reachable. Stop it and register the extension before browser launch.",
      );
    }
    if (getBrowserControlState() !== state) {
      throw new Error("Browser runtime changed during extension registration.");
    }
    extensionDeclarations.set(profileName, declaration);
  });
  return {
    openSession: async (options) => {
      assertCurrent();
      const taskProfileCtx = createBrowserControlContext().forProfile(profileName);
      assertExtensionProfile(taskProfileCtx);
      await taskProfileCtx.ensureBrowserAvailable();
      assertCurrent();
      const runtime = state.profiles.get(profileName);
      const running = runtime?.running;
      if (!runtime || !running || running.extensionDeclaration !== declaration) {
        throw new Error(
          "Browser was not launched with this extension declaration. Stop the browser and retry.",
        );
      }
      const assertSessionCurrent = () => {
        assertCurrent();
        if (runtime.running !== running || state.profiles.get(profileName) !== runtime) {
          throw new Error("Browser extension session belongs to a stopped or replaced browser.");
        }
      };
      const session = await openWorkerSession({
        declaration,
        profileCtx: taskProfileCtx,
        runtime,
        assertCurrent: assertSessionCurrent,
        timeoutMs: options?.timeoutMs ?? 120_000,
        onClose: (closedSession) => sessions.delete(closedSession),
      });
      try {
        assertSessionCurrent();
      } catch (error) {
        await session.close();
        throw error;
      }
      sessions.add(session);
      return session;
    },
    close: () => {
      closed = true;
      closing ??= (async () => {
        await Promise.all([...sessions].map((session) => session.close()));
        // A completed runtime shutdown already retired this declaration. Never
        // stop a replacement runtime when closing the old registration.
        if (extensionDeclarations.get(profileName) !== declaration) {
          return;
        }
        // Keep ownership reserved after cleanup failure, but allow an explicit retry.
        await profileCtx.stopRunningBrowser();
        if (extensionDeclarations.get(profileName) === declaration) {
          extensionDeclarations.delete(profileName);
        }
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}

/** Attach once and retain the raw, non-logging CDP socket until task closure. */
async function openWorkerSession(params: {
  declaration: ExtensionDeclaration;
  profileCtx: ProfileContext;
  runtime: ProfileRuntimeState;
  assertCurrent: () => void;
  timeoutMs: number;
  onClose: (session: ExtensionHostSession) => void;
}): Promise<ExtensionHostSession> {
  if (
    !Number.isSafeInteger(params.timeoutMs) ||
    params.timeoutMs < 1 ||
    params.timeoutMs > 600_000
  ) {
    throw new Error("Extension timeoutMs must be an integer between 1 and 600000.");
  }
  const endpoint = await getChromeWebSocketEndpoint(params.profileCtx.profile.cdpUrl);
  params.assertCurrent();
  if (!endpoint) {
    throw new Error("Managed browser CDP endpoint is unavailable.");
  }
  const ready = createDeferred<{ send: CdpSendFn; sessionId: string }>();
  const workerTarget = createDeferred<string>();
  let executionContext = createDeferred<number>();
  let contextId: number | undefined;
  let scriptLoaded = false;
  let contextReady = false;
  const resolveExecutionContext = () => {
    if (contextId !== undefined && scriptLoaded) {
      contextReady = true;
      executionContext.resolve(contextId);
    }
  };
  const workerTimer = setTimeout(
    () =>
      ready.reject(
        new Error(
          "Declared extension worker is missing. Verify extension id, manifest key, and browser build.",
        ),
      ),
    params.timeoutMs,
  );
  const done = createDeferred<void>();
  let closed = false;
  let exclusive = false;
  let lost = false;
  let workerId: string | undefined;
  let workerSessionId: string | undefined;
  const workerLost = createDeferred<never>();
  void workerLost.promise.catch(() => {});
  const markWorkerLost = () => {
    if (closed || lost) {
      return;
    }
    lost = true;
    if (exclusive) {
      quarantineExtensionProfile(params.runtime);
    }
    const error = new Error(
      "Extension worker disconnected. Stop the browser before retrying an interrupted exclusive operation.",
    );
    workerLost.reject(error);
    workerTarget.reject(error);
    ready.reject(error);
    done.resolve();
  };
  const connection = withCdpSocket(
    endpoint.url,
    async (send) => {
      await send("Target.setDiscoverTargets", { discover: true });
      const targets = targetsSchema.parse(await send("Target.getTargets"));
      const worker = targets.targetInfos.find(
        (target) =>
          target.type === "service_worker" && target.url === params.declaration.workerPath,
      );
      if (worker) {
        workerTarget.resolve(worker.targetId);
      }
      workerId = await workerTarget.promise;
      const attached = attachedSchema.parse(
        await send("Target.attachToTarget", { targetId: workerId, flatten: true }),
      );
      workerSessionId = attached.sessionId;
      // Runtime can expose a pre-script global: even timers do not run there.
      // Chromium emits workerScriptLoaded when the worker can execute async work.
      await send("Runtime.enable", {}, attached.sessionId);
      await send("Runtime.runIfWaitingForDebugger", {}, attached.sessionId);
      await Promise.race([executionContext.promise, workerLost.promise]);
      ready.resolve({ send, sessionId: attached.sessionId });
      await done.promise;
      await send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
    },
    {
      lookup: endpoint.lookup,
      commandTimeoutMs: params.timeoutMs,
      handshakeRetries: 0,
      onClose: markWorkerLost,
      onEvent: (event) => {
        if (workerSessionId !== undefined && event.sessionId === workerSessionId) {
          if (event.method === "Runtime.executionContextCreated") {
            const parsed = z
              .object({ context: z.object({ id: z.number() }) })
              .safeParse(event.params);
            if (parsed.success) {
              contextId = parsed.data.context.id;
              resolveExecutionContext();
            }
          } else if (event.method === "Inspector.workerScriptLoaded") {
            scriptLoaded = true;
            resolveExecutionContext();
          } else if (
            event.method === "Runtime.executionContextsCleared" ||
            (event.method === "Runtime.executionContextDestroyed" &&
              z.object({ executionContextId: z.number() }).safeParse(event.params).data
                ?.executionContextId === contextId)
          ) {
            if (exclusive) {
              markWorkerLost();
              return;
            }
            contextId = undefined;
            scriptLoaded = false;
            if (contextReady) {
              executionContext = createDeferred<number>();
              contextReady = false;
            }
          }
        }
        const targetLoss = z.object({ targetId: z.string() }).safeParse(event.params);
        const sessionLoss = z.object({ sessionId: z.string() }).safeParse(event.params);
        if (
          ((event.method === "Target.targetDestroyed" || event.method === "Target.targetCrashed") &&
            targetLoss.success &&
            targetLoss.data.targetId === workerId) ||
          (event.method === "Target.detachedFromTarget" &&
            sessionLoss.success &&
            sessionLoss.data.sessionId === workerSessionId) ||
          (event.method === "Inspector.detached" &&
            workerSessionId !== undefined &&
            event.sessionId === workerSessionId)
        ) {
          markWorkerLost();
          return;
        }
        if (
          event.method === "Target.targetCreated" ||
          event.method === "Target.targetInfoChanged"
        ) {
          const parsed = z
            .object({ targetInfo: targetsSchema.shape.targetInfos.element })
            .safeParse(event.params);
          if (
            parsed.success &&
            parsed.data.targetInfo.type === "service_worker" &&
            parsed.data.targetInfo.url === params.declaration.workerPath
          ) {
            workerTarget.resolve(parsed.data.targetInfo.targetId);
          }
        }
      },
    },
  );
  // Both deferreds have rejection handlers even if the handshake fails first.
  void workerTarget.promise.catch(() => {});
  void connection.catch((error: unknown) => ready.reject(error));
  let attachedWorker: Awaited<typeof ready.promise>;
  try {
    attachedWorker = await ready.promise;
  } catch (error) {
    workerTarget.reject(error);
    done.resolve();
    // Release startup waits as well as a retained session when admission fails.
    workerLost.reject(error);
    await connection.catch(() => {});
    throw error;
  } finally {
    clearTimeout(workerTimer);
  }
  const { send, sessionId } = attachedWorker;
  const assertCurrent = () => {
    if (closed || lost) {
      throw new Error("Browser extension task session is closed or disconnected.");
    }
    params.assertCurrent();
  };
  const waitForExecutionContext = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        executionContext.promise,
        workerLost.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Extension worker execution context timed out.")),
            params.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const close = async () => {
    if (exclusive) {
      quarantineExtensionProfile(params.runtime);
    }
    closed = true;
    workerLost.reject(new Error("Browser extension task session is closed."));
    params.onClose(session);
    done.resolve();
    await connection.catch(() => {});
  };
  const session: ExtensionHostSession = {
    callInServiceWorker: async <A>(fn: (args: A) => unknown, args: A): Promise<unknown> => {
      assertCurrent();
      return await runProfileContextOperation(params.profileCtx, undefined, async () => {
        assertCurrent();
        try {
          const executionContextId = await waitForExecutionContext();
          assertCurrent();
          // Source contains only caller-authored code. Secrets travel as call arguments,
          // never interpolated source; neither transport traffic nor worker errors are logged.
          const response = evaluationSchema.parse(
            await send(
              "Runtime.callFunctionOn",
              {
                functionDeclaration: `function(args) { return (${fn.toString()})(args); }`,
                executionContextId,
                arguments: [{ value: args }],
                awaitPromise: true,
                returnByValue: true,
              },
              sessionId,
            ),
          );
          assertCurrent();
          if (response.exceptionDetails) {
            throw new Error("Worker function failed.");
          }
          // Worker output crosses a trust boundary; callers validate its shape.
          return response.result.value;
        } catch {
          if (exclusive) {
            quarantineExtensionProfile(params.runtime);
          }
          await close();
          throw new Error(
            "Extension worker call failed or timed out; no worker error details were retained.",
          );
        }
      });
    },
    resolveChromeTabId: async ({ targetId }) => {
      assertCurrent();
      const tab = await params.profileCtx.ensureTabAvailable(targetId);
      assertCurrent();
      const id = await session.callInServiceWorker((url: string) => {
        // WebExtension globals exist only inside this worker, not the Gateway.
        return chrome.tabs.query({}).then((tabs) => {
          const matches = tabs.filter((candidate) => candidate.url === url);
          return matches.length === 1 ? matches[0]?.id : undefined;
        });
      }, tab.url);
      if (typeof id !== "number" || !Number.isSafeInteger(id)) {
        throw new Error(
          "Cannot uniquely map this browser target to a Chrome tab id. Close duplicate-URL tabs and retry.",
        );
      }
      return id;
    },
    withExclusiveTab: async ({ targetId }, fn) => {
      assertCurrent();
      return await runProfileContextOperation(
        params.profileCtx,
        undefined,
        async () => {
          assertCurrent();
          await params.profileCtx.ensureTabAvailable(targetId);
          assertCurrent();
          const matchesEndpoint = (cdpUrl: string) =>
            matchesExtensionBrowserEndpoint(params.profileCtx.profile, cdpUrl);
          const activeTrace = [...cachedByCdpUrl].some(
            ([cdpUrl, connected]) =>
              matchesEndpoint(cdpUrl) &&
              connected.browser
                .contexts()
                .some((context) => contextStates.get(context)?.traceActive),
          );
          if (hasBrowserScreencast(matchesEndpoint) || activeTrace) {
            throw new ExtensionTabObservedError(
              "Stop browser screencasts and traces before an exclusive extension operation.",
            );
          }
          exclusive = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              fn(),
              workerLost.promise,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Exclusive extension operation timed out.")),
                  params.timeoutMs,
                );
              }),
            ]);
            assertCurrent();
            return result;
          } catch (error) {
            // Timeout/disconnect is not proof the extension cleared its fields. Keep
            // browser reads fenced until explicit stop, even after the task lock releases.
            quarantineExtensionProfile(params.runtime);
            await close();
            throw error;
          } finally {
            clearTimeout(timer);
            exclusive = false;
          }
        },
        { exclusive: true },
      );
    },
    close,
  };
  return session;
}
