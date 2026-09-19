import fs from "node:fs/promises";
// Real-transport proof for the recall completion capability: the runtime
// context produced by the same production builder that the recall assembly
// hands to context engines must carry the caller identity, the owning
// plugin's completion policy, and run authority through real model
// acquisition to the real provider boundary. Every completion observation
// here comes from an actual HTTP round trip against a local provider
// fixture, not from a mocked completion owner.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { buildAfterTurnRuntimeContext } from "./run/attempt-prompt-helpers.js";

const providerId = "fixture-real";
const policyPluginId = "real-transport-plugin";
const legacyPluginId = "legacy-unconfigured-plugin";
const allowedModel = `${providerId}/allowed-model`;
const forbiddenModel = `${providerId}/forbidden-model`;
const directText = "real-transport-direct-ok";
const isolatedText = "real-transport-isolated-ok";
const sessionKey = "agent:main:guildchat:channel:real-transport";

type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
};

const fixtureModels: ModelDefinitionConfig[] = [
  {
    id: "allowed-model",
    name: "Allowed",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  },
  {
    id: "forbidden-model",
    name: "Forbidden",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  },
];

function buildConfig(port: number, withCompletionPolicy: boolean): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: allowedModel,
      },
    },
    models: {
      providers: {
        [providerId]: {
          api: "openai-completions",
          apiKey: "fixture-real-key",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          models: fixtureModels,
        },
      },
    },
    plugins: {
      entries: withCompletionPolicy
        ? {
            [policyPluginId]: {
              llm: {
                allowedCompletionModels: [allowedModel],
                allowModelOverride: true,
              },
            },
          }
        : {
            // An existing engine owner with no completion-policy declaration:
            // the run-lifetime gate must not alter what such a configuration
            // could already complete while its run is active.
            [legacyPluginId]: { enabled: true },
          },
    },
  };
}

describe("context engine completion capability over real transport", () => {
  let server: Server | undefined;
  let requests: RecordedRequest[] = [];
  const tempPaths: string[] = [];
  let previousStateDir: string | undefined;
  let previousDisableBundled: string | undefined;
  /** Optional per-case handler for the runtime auth-exchange route. */
  let runtimeAuthExchangeHandler:
    | ((request: IncomingMessage, response: ServerResponse) => boolean)
    | undefined;

  const startServer = async (): Promise<number> => {
    server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (runtimeAuthExchangeHandler?.(request, response)) {
          return;
        }
        // The isolated completion route answers with a different marker so the
        // two dispatch modes are distinguishable at the final I/O boundary.
        const text = requests.length % 2 === 0 ? isolatedText : directText;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "real-transport-response",
            object: "chat.completion.chunk",
            model: "allowed-model",
            choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => {
        server?.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Real-transport fixture did not expose a TCP port");
    }
    return address.port;
  };

  const makeTempDir = async (prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempPaths.push(dir);
    return dir;
  };

  const buildRecallRuntimeContext = async (
    config: ReturnType<typeof buildConfig>,
    ownerPluginId: string,
    assertRunAuthorityActive: (() => void) | undefined,
  ): Promise<ContextEngineRuntimeContext> => {
    // The production recall builder: this is the exact function the attempt
    // assembly calls for initial (pre-turn) and mid-turn recall, so the
    // runtime context and its minted llm capability here are the ones a
    // registered engine would receive during a real turn.
    const workspaceDir = await makeTempDir("openclaw-real-transport-workspace-");
    const agentDir = await makeTempDir("openclaw-real-transport-agent-");
    return buildAfterTurnRuntimeContext({
      attempt: {
        sessionId: "embedded-session",
        sessionKey,
        senderId: "user-42",
        config,
        provider: providerId,
        modelId: "allowed-model",
      } as Parameters<typeof buildAfterTurnRuntimeContext>[0]["attempt"],
      workspaceDir,
      agentDir,
      contextEnginePluginId: ownerPluginId,
      assertRunAuthorityActive,
    } as Parameters<typeof buildAfterTurnRuntimeContext>[0]);
  };

  beforeEach(() => {
    requests = [];
    runtimeAuthExchangeHandler = undefined;
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    previousDisableBundled = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousDisableBundled === undefined) {
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    } else {
      process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundled;
    }
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      // A case that fails while an exchange response is held must not wedge
      // the hook on close(): drop any lingering socket deterministically.
      server.closeAllConnections?.();
    });
    server = undefined;
    await Promise.all(
      tempPaths.map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })),
    );
    tempPaths.length = 0;
  });

  it("completes recall probes from the production builder over real transport and denies excluded models", async () => {
    const stateRoot = await makeTempDir("openclaw-real-transport-state-");
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const port = await startServer();
    const config = buildConfig(port, true);

    // One admitted run authority, exactly like the attempt flow that mints
    // the capability for recall.
    const admission = prepareSystemAgentRunAdmission(config, "real-transport-run", "main", "test");
    const admitted = await admission.admit("embedded");
    const assertActive = resolveAdmittedRunActiveAssertion(admitted);
    expect(assertActive).toBeTypeOf("function");

    const runtimeContext = await buildRecallRuntimeContext(config, policyPluginId, assertActive);

    // Real recall identity from the production builder: the same sender
    // identity the capture path gets, plus the minted capability face.
    expect(runtimeContext.senderId).toBe("user-42");
    const complete = runtimeContext.llm?.complete;
    expect(complete).toBeTypeOf("function");

    // The policy-excluded model is denied by the owning plugin's completion
    // allowlist before acquisition, and the provider sees no traffic.
    await expect(
      complete?.({
        model: forbiddenModel,
        messages: [{ role: "user", content: "forbidden probe" }],
      } as never),
    ).rejects.toThrow(/is not allowlisted .* for plugin "real-transport-plugin"/u);
    expect(requests.length).toBe(0);

    // The allowlisted direct completion passes real acquisition and reaches
    // the real provider boundary: the local server observed the HTTP request,
    // and the streamed answer is the completion result.
    const direct = (await complete?.({
      model: allowedModel,
      messages: [{ role: "user", content: "direct recall probe" }],
    } as never)) as { text?: string };
    expect(direct?.text).toBe(directText);
    expect(requests.length).toBe(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toContain("/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer fixture-real-key");
    expect(requests[0]?.body).toContain("direct recall probe");

    // The isolated runtime mode dispatches through the real isolated
    // completion owner and reaches the same real provider boundary.
    const isolated = (await complete?.({
      model: allowedModel,
      messages: [{ role: "user", content: "isolated recall probe" }],
      execution: { mode: "isolated-agent-runtime" },
    } as never)) as { text?: string };
    expect(isolated?.text).toBe(isolatedText);
    expect(requests.length).toBe(2);
    expect(requests[1]?.body).toContain("isolated recall probe");

    // Compatibility face of the run-lifetime gate: a capability an engine
    // retained across the turn is refused with a clear authority error after
    // the admitting run closes, and the provider sees no further traffic.
    closeAdmittedRunDelegatedAuthority(admitted);
    await expect(
      complete?.({
        model: allowedModel,
        messages: [{ role: "user", content: "retained call" }],
      } as never),
    ).rejects.toThrow(/admitted run authority is no longer active/u);
    expect(requests.length).toBe(2);
  }, 90_000);

  it("keeps an existing unconfigured plugin owner completing over real transport", async () => {
    const stateRoot = await makeTempDir("openclaw-real-transport-legacy-state-");
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const port = await startServer();
    const config = buildConfig(port, false);

    const admission = prepareSystemAgentRunAdmission(config, "legacy-plugin-run", "main", "test");
    const admitted = await admission.admit("embedded");
    const assertActive = resolveAdmittedRunActiveAssertion(admitted);

    // An existing engine owner without any completion-policy declaration:
    // while its run is active, its recall completions still pass real
    // acquisition and reach the real provider boundary unchanged.
    const runtimeContext = await buildRecallRuntimeContext(config, legacyPluginId, assertActive);
    expect(runtimeContext.senderId).toBe("user-42");
    const legacy = (await runtimeContext.llm?.complete?.({
      messages: [{ role: "user", content: "legacy recall probe" }],
    } as never)) as { text?: string };
    expect(legacy?.text).toBe(directText);
    expect(requests.length).toBe(1);
    expect(requests[0]?.body).toContain("legacy recall probe");
  }, 90_000);

  it("rejects a preparing completion whose run authority is revoked during the real runtime auth exchange", async () => {
    const root = await makeTempDir("openclaw-real-transport-revoke-");
    const pluginDir = path.join(root, "plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    const fixture = createColdPluginFixture({
      rootDir: pluginDir,
      pluginId: "real-transport-exchange-plugin",
      providerId,
    });
    // The production runtime auth-exchange seam: this plugin owns the
    // provider's runtime credential and exchanges it over real HTTP inside
    // acquisition, exactly where the attempt flow suspends on awaited
    // preparation work. Revoking run authority while that exchange is in
    // flight must stop the completion before any provider dispatch.
    const exchangeArrivals = [createDeferred(), createDeferred()];
    const exchangeGates = [createDeferred(), createDeferred()];
    let exchanges = 0;
    await fs.writeFile(
      fixture.runtimeSource,
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
        api.registerProvider({
          id: ${JSON.stringify(providerId)}, label: "Real transport exchange", auth: [],
          async prepareRuntimeAuth(ctx) {
            const response = await fetch(ctx.env.OPENCLAW_FIXTURE_RUNTIME_AUTH_URL + "/runtime-auth-exchange", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sourceKey: ctx.apiKey }),
            });
            const payload = await response.json();
            return { apiKey: payload.runtimeKey };
          },
        });
      } };`,
    );

    const previousHome = process.env.OPENCLAW_HOME;
    const previousBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const previousVersion = process.env.OPENCLAW_VERSION;
    const previousExchangeUrl = process.env.OPENCLAW_FIXTURE_RUNTIME_AUTH_URL;

    try {
      process.env.OPENCLAW_HOME = path.join(root, "home");
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(root, "bundled-plugins");
      process.env.OPENCLAW_VERSION = "2026.4.25";
      process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
      runtimeAuthExchangeHandler = (request, response) => {
        // Only the runtime auth-exchange route is intercepted; chat/completions
        // must always take the normal fixture path so a buggy dispatch shows
        // up as an assertion instead of a held socket.
        if (!request.url?.includes("/runtime-auth-exchange")) {
          return false;
        }
        exchanges += 1;
        exchangeArrivals[exchanges - 1]?.resolve();
        // Hold the exchange open until the test has revoked the admitting
        // run, so the revocation deterministically lands while acquisition
        // is suspended on real network work.
        void Promise.race([
          exchangeGates[exchanges - 1]!.promise,
          new Promise((resolve) => {
            setTimeout(resolve, 10_000);
          }),
        ]).then(() => {
          if (response.destroyed || response.writableEnded) {
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ runtimeKey: "exchanged-runtime-key" }));
        });
        return true;
      };
      const port = await startServer();
      process.env.OPENCLAW_FIXTURE_RUNTIME_AUTH_URL = `http://127.0.0.1:${port}`;
      process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: allowedModel,
          },
        },
        models: {
          providers: {
            [providerId]: {
              api: "openai-completions",
              apiKey: "fixture-real-key",
              baseUrl: `http://127.0.0.1:${port}/v1`,
              models: fixtureModels,
            },
          },
        },
        plugins: {
          load: { paths: [fixture.rootDir] },
          entries: {
            [fixture.pluginId]: {
              enabled: true,
              llm: { allowedCompletionModels: [allowedModel] },
            },
          },
        },
      };

      const beginRevokedCompletion = (
        runLabel: string,
        probe: string,
        execution?: { mode: string },
      ) => {
        const exchangeIndex = exchanges;
        const admission = prepareSystemAgentRunAdmission(config, runLabel, "main", "test");
        return admission.admit("embedded").then(async (admitted) => {
          const assertActive = resolveAdmittedRunActiveAssertion(admitted);
          const runtimeContext = await buildRecallRuntimeContext(
            config,
            fixture.pluginId,
            assertActive,
          );
          // The agent's configured default model keeps this inside the owning
          // plugin's completion allowlist without a model-override authority.
          const pending = runtimeContext.llm?.complete?.({
            messages: [{ role: "user", content: probe }],
            ...(execution ? { execution } : {}),
          } as never) as Promise<unknown>;
          // Fail fast with a clear diagnosis if the completion settles before
          // the exchange arrives: that would mean revocation was not observed
          // during preparation at all.
          const earlyFailure = pending.then(
            () => {
              throw new Error("completion resolved before the run authority was revoked");
            },
            (error: unknown) => {
              throw new Error(
                `completion rejected before the auth exchange arrived: ${formatErrorMessage(error)}`,
              );
            },
          );
          earlyFailure.catch(() => {});
          return async () => {
            // The exchange POST arriving at the fixture is the deterministic
            // real-transport signal that acquisition is in flight. Close the
            // admitting run now, then release the exchanged credential.
            await exchangeArrivals[exchangeIndex]!.promise;
            closeAdmittedRunDelegatedAuthority(admitted);
            exchangeGates[exchangeIndex]!.resolve();
            return await pending;
          };
        });
      };

      const revokeDirect = await beginRevokedCompletion(
        "revoke-preparing-direct",
        "preparing direct probe",
      );
      await expect(revokeDirect()).rejects.toThrow(/admitted run authority is no longer active/u);
      expect(exchanges).toBe(1);

      const revokeIsolated = await beginRevokedCompletion(
        "revoke-preparing-isolated",
        "preparing isolated probe",
        { mode: "isolated-agent-runtime" },
      );
      await expect(revokeIsolated()).rejects.toThrow(/admitted run authority is no longer active/u);
      expect(exchanges).toBe(2);

      const chatDispatches = requests.filter((request) =>
        request.url.includes("/chat/completions"),
      );
      expect(chatDispatches.length).toBe(0);
      console.log(
        "[preparation-revocation proof]",
        JSON.stringify({
          direct: "rejected while runtime auth exchange was in flight",
          isolated: "rejected while runtime auth exchange was in flight",
          authExchangesObserved: exchanges,
          providerChatCompletions: chatDispatches.length,
        }),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousHome;
      }
      if (previousBundledDir === undefined) {
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      } else {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledDir;
      }
      if (previousVersion === undefined) {
        delete process.env.OPENCLAW_VERSION;
      } else {
        process.env.OPENCLAW_VERSION = previousVersion;
      }
      if (previousExchangeUrl === undefined) {
        delete process.env.OPENCLAW_FIXTURE_RUNTIME_AUTH_URL;
      } else {
        process.env.OPENCLAW_FIXTURE_RUNTIME_AUTH_URL = previousExchangeUrl;
      }
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      clearPluginMetadataLifecycleCaches();
      resetPluginLoaderTestStateForTest();
    }
  }, 90_000);
});
