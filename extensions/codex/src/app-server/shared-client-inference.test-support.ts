import { expect, it, vi, type Mock } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import { prepareCodexInferenceThreadConfig } from "./inference-routing.js";
import { retireSharedCodexAppServerClientsBeforeDesktopGeneration } from "./shared-client-lifecycle.js";
import {
  getLeasedSharedCodexAppServerClient,
  getSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

type DesktopInferenceFixture = {
  desktopGeneration: CodexDesktopGeneration | undefined;
  desktopGenerationCurrent: boolean;
  resolveManagedCodexAppServerStartOptions: Pick<
    Mock<(startOptions: CodexAppServerStartOptions) => Promise<CodexAppServerStartOptions>>,
    "mockImplementation"
  >;
};

export function configureManagedDesktopInferenceFixture(
  mocks: DesktopInferenceFixture,
): CodexAppServerStartOptions {
  mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
    ...startOptions,
    command: "/Applications/Codex.app/Contents/Resources/codex",
    commandSource: "resolved-managed",
    managedFallbackCommandPaths: ["/cache/openclaw/codex"],
  }));
  return {
    transport: "stdio",
    homeScope: "user",
    command: "codex",
    commandSource: "managed",
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

/** Register under the shared-client suite so startup mocks and cleanup remain authoritative. */
export function registerSharedClientInferenceTests(
  mocks: DesktopInferenceFixture,
  sendInitializeResult: (
    harness: ReturnType<typeof createClientHarness>,
    userAgent: string,
  ) => Promise<void>,
) {
  it.each(["config", "proxy", "untracked-desktop"] as const)(
    "does not claim inference for a %s Desktop connection",
    async (kind) => {
      mocks.desktopGeneration =
        kind === "untracked-desktop" ? undefined : { epoch: 1, fingerprint: "desktop-x" };
      const desktop = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(desktop.client);
      const startOptions = configureManagedDesktopInferenceFixture(mocks);
      if (kind === "config") {
        mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async () => ({
          ...startOptions,
          command: "/Applications/Codex.app/Contents/Resources/codex",
          commandSource: "config",
        }));
      } else if (kind === "proxy") {
        startOptions.args = ["app-server", "proxy"];
      }
      const acquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
      await sendInitializeResult(desktop, "openclaw/0.149.0 (macOS; test)");
      const client = await acquire;
      await expect(
        prepareCodexInferenceThreadConfig({
          client,
          binding: undefined,
          clientId: client.getInstanceId(),
          cwd: "/tmp/openclaw-workspace",
          effectiveConfig: { config: {}, origins: {} },
          assertCurrent: () => {},
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("owns parent-local inference for a generation-bound managed Desktop client", async () => {
    const generation = { epoch: 1, fingerprint: "desktop-x" };
    mocks.desktopGeneration = generation;
    const desktop = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "account/read") {
          send({ id: request.id, result: { account: { type: "chatgpt" } } });
        }
      },
    });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(desktop.client);
    const startOptions = configureManagedDesktopInferenceFixture(mocks);

    const acquire = getLeasedSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await sendInitializeResult(desktop, "openclaw/0.149.0 (macOS; test)");
    const client = await acquire;

    expect(readCodexAppServerClientDesktopGeneration(client)).toEqual(generation);
    const inference = await prepareCodexInferenceThreadConfig({
      client,
      binding: undefined,
      clientId: client.getInstanceId(),
      cwd: "/tmp/openclaw-workspace",
      effectiveConfig: { config: {}, origins: {} },
      assertCurrent: () => {},
    });
    expect(inference?.route.upstream).toBe("https://chatgpt.com/backend-api/codex");
    expect(inference?.config.openai_base_url).toBe(inference?.route.baseUrl);
    expect(() => inference?.route.assertCurrent()).not.toThrow();

    mocks.desktopGenerationCurrent = false;
    expect(desktop.process.stdin.destroyed).toBe(false);
    expect(() => inference?.route.assertCurrent()).toThrow();

    retireSharedCodexAppServerClientsBeforeDesktopGeneration({
      epoch: 2,
      fingerprint: "desktop-y",
    });
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    expect(() => inference?.route.assertCurrent()).toThrow();
  });
}
