import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";

let sharedClient: CodexAppServerClient | undefined;
let sharedClientPromise: Promise<CodexAppServerClient> | undefined;
let sharedClientKey: string | undefined;

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
}): Promise<CodexAppServerClient> {
  const startOptions = options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const key = codexAppServerStartOptionsKey(startOptions);
  if (sharedClientKey && sharedClientKey !== key) {
    clearSharedCodexAppServerClient();
  }
  sharedClientKey = key;
  sharedClientPromise ??= (async () => {
    const client = CodexAppServerClient.start(startOptions);
    sharedClient = client;
    client.addCloseHandler(clearSharedClientIfCurrent);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      // Startup failures happen before callers own the shared client, so close
      // the child here instead of leaving a rejected daemon attached to stdio.
      client.close();
      throw error;
    }
  })();
  try {
    return await sharedClientPromise;
  } catch (error) {
    sharedClient = undefined;
    sharedClientPromise = undefined;
    sharedClientKey = undefined;
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  sharedClient = undefined;
  sharedClientPromise = undefined;
  sharedClientKey = undefined;
}

export function clearSharedCodexAppServerClient(): void {
  const client = sharedClient;
  sharedClient = undefined;
  sharedClientPromise = undefined;
  sharedClientKey = undefined;
  client?.close();
}

function clearSharedClientIfCurrent(client: CodexAppServerClient): void {
  if (sharedClient !== client) {
    return;
  }
  sharedClient = undefined;
  sharedClientPromise = undefined;
  sharedClientKey = undefined;
}
