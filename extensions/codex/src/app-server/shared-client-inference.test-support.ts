import { expect, it, onTestFinished, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import { prepareCodexInferenceThreadConfig } from "./inference-routing.js";
import {
  getLeasedSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Registers startup qualification under the suite's shared auth and generation fixtures. */
export function registerSharedClientInferenceTests(
  configureNativeStart: (generation: CodexDesktopGeneration, command: string) => void,
  sendInitializeResult: (
    harness: ReturnType<typeof createClientHarness>,
    userAgent: string,
  ) => Promise<void>,
): void {
  it.each([
    {
      label: "managed Desktop",
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "managed",
      transport: "stdio",
      args: ["app-server"],
      ownsInference: true,
    },
    {
      label: "generation-bound package",
      command: "/cache/openclaw/codex",
      commandSource: "managed",
      transport: "stdio",
      args: ["app-server"],
      ownsInference: true,
    },
    {
      label: "explicit Desktop override",
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "config",
      transport: "stdio",
      args: ["app-server"],
      ownsInference: false,
    },
    {
      label: "managed Desktop proxy",
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "managed",
      transport: "stdio",
      args: ["app-server", "proxy", "--url", "ws://127.0.0.1:39175"],
      ownsInference: false,
    },
    {
      label: "external Desktop socket",
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "managed",
      transport: "websocket",
      args: [],
      ownsInference: false,
    },
  ] as const)("preserves inference ownership for $label", async (entry) => {
    // Native profile compatibility is covered separately; this probes physical startup ownership.
    for (const key of [
      "CODEX_CA_CERTIFICATE",
      "SSL_CERT_FILE",
      "REQUEST_METHOD",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ]) {
      vi.stubEnv(key, undefined);
    }
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const generation = { epoch: 1, fingerprint: "desktop-inference" };
    configureNativeStart(generation, entry.command);
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
      startOptions: {
        transport: entry.transport,
        homeScope: "agent",
        command: entry.command,
        commandSource: entry.commandSource,
        args: [...entry.args],
        headers: {},
        ...(entry.transport === "websocket" ? { url: "ws://127.0.0.1:39175" } : {}),
      },
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
    if (!entry.ownsInference) {
      expect(prepared).toBeUndefined();
      return;
    }
    expect(readCodexAppServerClientDesktopGeneration(client)).toEqual(generation);
    expect(prepared).toBeDefined();
    if (!prepared) {
      throw new Error("Owned native startup did not prepare its inference route");
    }
    expect(prepared.config).toEqual({ openai_base_url: prepared.route.baseUrl });
    // Physical process shutdown must revoke the confidential context, not just stop discovery.
    const registration = prepared.route.context.register({
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
    configureNativeStart(generation, "/Applications/ChatGPT.app/Contents/Resources/codex");
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

    const clientPromise = getLeasedSharedCodexAppServerClient({
      config: {},
      pluginConfig: { computerUse: { enabled: false } },
      agentDir: "/tmp/openclaw-agent",
      startOptions: {
        transport: "stdio",
        homeScope: "agent",
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
        commandSource: "config",
        args: ["app-server"],
        headers: {},
      },
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    const client = await clientPromise;

    expect(readCodexAppServerClientDesktopGeneration(client)).toEqual(generation);
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
  });
}
