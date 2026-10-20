import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import {
  closeOwnedStdioProcess,
  createOwnedStdioProcess,
} from "openclaw/plugin-sdk/process-runtime";
import { CodexAppServerClient } from "./client.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import {
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
} from "./session-binding-meta.js";
import { createCodexAppServerBindingStore } from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { getSharedCodexAppServerClientState } from "./shared-client-lifecycle.js";
import { clearSharedCodexAppServerClientAndWait } from "./shared-client.js";

async function waitForSocket(socketPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    // Subscribe before the first stat so binding between the check and wait cannot be missed.
    const watcher = watch(path.dirname(socketPath), () => void check());
    const finish = (error?: unknown) => {
      watcher.close();
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(
          error instanceof Error ? error : new Error("Native startup failed", { cause: error }),
        );
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(signal.reason);
    async function check() {
      try {
        if ((await fs.stat(socketPath)).isSocket()) {
          finish();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          finish(error);
        }
      }
    }
    watcher.once("error", finish);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    } else {
      void check();
    }
  });
}

/** Real pinned Codex with private native credentials and a caller-owned Responses server. */
export async function createWorkshopReviewNativeFixture(options: {
  root: string;
  baseUrl: string;
  modelId: string;
  signal: AbortSignal;
  apiKey: string;
}) {
  const native = await createCodexNativeTestState(options.root);
  // Keep this directly below the caller's short temp root: macOS limits Unix socket paths.
  const socketPath = path.join(options.root, "rpc.sock");
  const appServerUrl = `unix://${socketPath}`;
  const catalogPath = path.join(options.root, "models.json");
  await fs.writeFile(
    catalogPath,
    JSON.stringify({
      models: [
        {
          slug: options.modelId,
          display_name: "Synthetic Workshop model",
          supported_reasoning_levels: [],
          shell_type: "local",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          support_verbosity: false,
          truncation_policy: { mode: "bytes", limit: 10000 },
          experimental_supported_tools: [],
          context_window: 200_000,
          model_messages: {
            instructions_template: "You are a test assistant.",
            collaboration_modes: { default: "Synthetic model-owned Default policy." },
          },
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(native.codexHome, "config.toml"),
    [
      `model=${JSON.stringify(options.modelId)}`,
      'model_provider="openai"',
      `openai_base_url=${JSON.stringify(options.baseUrl)}`,
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      'cli_auth_credentials_store="ephemeral"',
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      "[analytics]",
      "enabled=false",
      "[feedback]",
      "enabled=false",
    ].join("\n"),
  );

  let stderr = "";
  const child = await createOwnedStdioProcess({
    argv: [native.command, "app-server", "--listen", appServerUrl],
    cwd: native.cwd,
    env: native.env,
    exactEnv: true,
    abortSignal: options.signal,
    stderrDestination: new Writable({
      write(chunk: Buffer, _encoding, done) {
        stderr = (stderr + chunk.toString("utf8")).slice(-8_192);
        done();
      },
    }),
  });
  let control: CodexAppServerClient | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await clearSharedCodexAppServerClientAndWait();
        await control?.closeAndWait();
      } finally {
        child.kill("SIGTERM");
        await closeOwnedStdioProcess(child);
      }
    })());
  const startup = new AbortController();
  try {
    await Promise.race([
      waitForSocket(socketPath, AbortSignal.any([options.signal, startup.signal])),
      child.wait().then(({ code, signal }) => {
        throw new Error(`Native Workshop startup exited (${code ?? signal}): ${stderr}`);
      }),
    ]);
  } catch (error) {
    await close();
    throw error;
  } finally {
    startup.abort();
  }

  try {
    control = await CodexAppServerClient.start({
      transport: "unix",
      command: native.command,
      args: [],
      headers: {},
      url: appServerUrl,
    });
    await control.initialize();
    await control.request("account/login/start", { type: "apiKey", apiKey: options.apiKey });
    const { account } = await control.request("account/read", { refreshToken: false });
    if (account?.type !== "apiKey") {
      throw new Error("Native fixture did not select its private API account");
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    control,
    beforeNextTurn(beforeDispatch: () => Promise<void>) {
      // Plugin module copies share their client owner, not necessarily class prototypes.
      const clients = getSharedCodexAppServerClientState().liveClients;
      const restores: (() => void)[] = [];
      let pending = true;
      const observe = (client: CodexAppServerClient) => {
        const request = client.request.bind(client);
        client.request = new Proxy(request, {
          async apply(target, receiver, args) {
            if (pending && args[0] === "turn/start") {
              pending = false;
              await beforeDispatch();
            }
            return Reflect.apply(target, receiver, args);
          },
        });
        restores.push(() => {
          client.request = request;
        });
      };
      for (const client of clients) {
        observe(client);
      }
      const add = clients.add.bind(clients);
      clients.add = (client) => {
        observe(client);
        return add(client);
      };
      return () => {
        clients.add = add;
        for (const restore of restores) {
          restore();
        }
      };
    },
    async bindAttachedSource(source: { agentId: string; sessionId: string; sessionKey: string }) {
      const { thread } = await control!.request("thread/start", {
        model: options.modelId,
        ephemeral: true,
        cwd: native.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const store = createCodexAppServerBindingStore(
        createCodexSqliteTestBindingStateStore({
          env: process.env,
          namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
          maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        }),
      );
      await store.mutate(
        { kind: "session", ...source },
        {
          kind: "set",
          binding: {
            threadId: thread.id,
            cwd: native.cwd,
            model: options.modelId,
            modelProvider: "openai",
            preserveNativeModel: true,
            connectionScope: "supervision",
            conversationSourceTransferComplete: true,
            supervisionSourceThreadId: thread.id,
            appServerRuntimeFingerprint: appServerUrl,
          },
        },
      );
    },
    // The private Unix server owns its account; it cannot borrow an operator login.
    appServer: { transport: "unix" as const, homeScope: "user" as const, url: appServerUrl },
    codexHome: native.codexHome,
    close,
  };
}
