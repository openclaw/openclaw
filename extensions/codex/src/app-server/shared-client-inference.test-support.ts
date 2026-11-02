import { expect, it, onTestFinished, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import { prepareCodexInferenceThreadConfig } from "./inference-routing.js";
import {
  getLeasedSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness, stubCodexInferenceTransportEnv } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const desktopCommand = "/Applications/ChatGPT.app/Contents/Resources/codex";
const startOptions = {
  transport: "stdio" as const,
  homeScope: "agent" as const,
  command: desktopCommand,
  commandSource: "managed" as const,
  args: ["app-server"],
  headers: {},
};

/** Registers startup qualification under the suite's shared auth and generation fixtures. */
export function registerSharedClientInferenceTests(
  configureNativeStart: (generation: CodexDesktopGeneration, command: string) => void,
  sendInitializeResult: (
    harness: ReturnType<typeof createClientHarness>,
    userAgent: string,
  ) => Promise<void>,
): void {
  it.each<[string, Partial<CodexAppServerStartOptions>, boolean]>([
    ["managed Desktop", {}, true],
    ["generation-bound package", { command: "/cache/openclaw/codex" }, true],
    ["explicit Desktop override", { commandSource: "config" }, false],
    [
      "managed Desktop proxy",
      { args: ["app-server", "proxy", "--url", "ws://127.0.0.1:39175"] },
      false,
    ],
    [
      "external Desktop socket",
      { transport: "websocket", args: [], url: "ws://127.0.0.1:39175" },
      false,
    ],
  ])("preserves inference ownership for %s", async (_label, overrides, ownsInference) => {
    stubCodexInferenceTransportEnv();
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const generation = { epoch: 1, fingerprint: "desktop-inference" };
    const options = {
      ...startOptions,
      ...overrides,
      args: [...(overrides.args ?? startOptions.args)],
    };
    configureNativeStart(generation, options.command);
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "initialize") {
          send({ id: request.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
        } else if (request.method === "account/read") {
          send({ id: request.id, result: { account: { type: "apiKey" } } });
        }
      },
    });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const client = await getLeasedSharedCodexAppServerClient({
      config: {},
      pluginConfig: { computerUse: { enabled: true, autoInstall: false } },
      agentDir: "/tmp/openclaw-agent",
      startOptions: options,
    });
    onTestFinished(async () => {
      await client.closeAndWait();
    });
    const prepared = await prepareCodexInferenceThreadConfig({
      client,
      clientId: "fixture-desktop-client",
      binding: undefined,
      cwd: "/workspace",
      effectiveConfig: { config: {}, origins: {} },
      assertCurrent: () => {},
    });
    if (!ownsInference) {
      expect(prepared).toBeUndefined();
      return;
    }
    expect(readCodexAppServerClientDesktopGeneration(client)).toEqual(generation);
    if (!prepared) {
      throw new Error("Owned native startup did not prepare its inference route");
    }
    expect(prepared.config).toEqual({ openai_base_url: prepared.route.baseUrl });
    // Physical process shutdown must revoke the confidential context, not just stop discovery.
    const registration = await prepared.route.context.register({
      threadId: "parent",
      text: "private workspace instructions",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const request = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "parent",
          request_kind: "turn",
          openclaw_inference_generation: registration.generation,
        }),
      },
    };
    expect(prepared.route.context.prepare(request).body).toEqual({
      ...request,
      instructions: "private workspace instructions",
    });
    await client.closeAndWait();
    expect(() => prepared.route.context.prepare(request)).toThrow("closed");
  });

  it("generation-binds an explicit desktop client while Computer Use is disabled", async () => {
    const generation = { epoch: 1, fingerprint: "desktop-x" };
    configureNativeStart(generation, desktopCommand);
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

    const clientPromise = getLeasedSharedCodexAppServerClient({
      config: {},
      pluginConfig: { computerUse: { enabled: false } },
      agentDir: "/tmp/openclaw-agent",
      startOptions: { ...startOptions, commandSource: "config" },
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    const client = await clientPromise;

    expect(readCodexAppServerClientDesktopGeneration(client)).toEqual(generation);
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
  });
}
