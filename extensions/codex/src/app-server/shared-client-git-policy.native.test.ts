import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import {
  listenForNativeResponses,
  nativeAppServerOptions,
  nativeProviderConfig,
  runNativeTurn,
  sendNativeResponse,
} from "./thread-native.test-support.js";
import { withCodexAppServerGitConfig } from "./transport-stdio.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(async () => {
  await clearSharedCodexAppServerClientAndWait();
  vi.unstubAllEnvs();
});

// The pinned binary owns real writer locks; the loopback provider requires no credentials.
it(
  "resumes a loaded native thread when catalog and turn Git policy preparation differ",
  { timeout: 60_000 },
  async (context) => {
    const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
    const root = await fs.realpath(tempDirs.make("codex-shared-git-policy-"));
    const native = await createCodexNativeTestState(root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("HOME", native.env.HOME);
    vi.stubEnv("CODEX_HOME", native.codexHome);
    const port = await listenForNativeResponses(context, (request, response) => {
      request.resume();
      request.on("end", () => {
        expect(request.headers.authorization).toBeUndefined();
        sendNativeResponse(response, "git-policy-response", {
          type: "message",
          role: "assistant",
          id: "git-policy-answer",
          content: [{ type: "output_text", text: "Writer retained." }],
        });
      });
    });
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      nativeProviderConfig(
        "git-policy-fixture",
        port,
        ['sandbox_mode="danger-full-access"'],
        ["code_mode=false"],
      ),
    );
    const base = nativeAppServerOptions(native).start;
    const options = {
      agentDir: path.join(root, "agent"),
      authProfileId: null,
      config: {},
      timeoutMs: 20_000,
    } as const;
    const catalog = await getLeasedSharedCodexAppServerClient({ ...options, startOptions: base });
    try {
      expect(catalog.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      const started = await catalog.request(
        "thread/start",
        {
          cwd: native.cwd,
          model: "gpt-5.6-luna",
          modelProvider: "git-policy-fixture",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
        { timeoutMs: 20_000 },
      );
      await runNativeTurn(catalog, started.thread.id, "Keep this writer loaded.", {
        timeoutMs: 20_000,
        completionTimeoutMs: 20_000,
      });
      const turn = await getLeasedSharedCodexAppServerClient({
        ...options,
        startOptions: withCodexAppServerGitConfig(base, "'maintenance.auto=false' 'gc.auto=0'"),
      });
      try {
        // A second native process fails here with "already has an active writer".
        const resumed = await turn.request(
          "thread/resume",
          { threadId: started.thread.id },
          { timeoutMs: 20_000 },
        );
        expect(resumed.thread.id).toBe(started.thread.id);
        expect(turn).toBe(catalog);
      } finally {
        releaseLeasedSharedCodexAppServerClient(turn);
      }
    } finally {
      releaseLeasedSharedCodexAppServerClient(catalog);
      await clearSharedCodexAppServerClientAndWait();
    }
  },
);
