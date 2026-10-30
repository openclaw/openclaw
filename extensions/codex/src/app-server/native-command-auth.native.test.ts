import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import {
  createCodexRuntimePlanFixture,
  createNativeRunParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { nativeProviderConfig } from "./thread-native.test-support.js";

setupRunAttemptTestHooks();
vi.unmock("node:child_process");

it("rejects the effective native endpoint before any thread or turn", async () => {
  const root = await fs.realpath(tempDir);
  const native = await createCodexNativeTestState(root);
  for (const [key, value] of Object.entries(native.env)) {
    if (value !== undefined) {
      vi.stubEnv(key, value);
    }
  }
  const provider = "command-fixture";
  await fs.writeFile(
    path.join(native.codexHome, "config.toml"),
    [
      nativeProviderConfig(
        provider,
        12345,
        ['sandbox_mode="read-only"'],
        ["shell_snapshot=false"],
      ).replace('base_url="http:', 'base_url="https:'),
      "[model_providers." + provider + ".auth]",
      "command=" + JSON.stringify(process.execPath),
      "args=" + JSON.stringify(["-e", 'process.stdout.write("synthetic-command-token")']),
    ].join("\n"),
  );
  const params = createNativeRunParams(path.join(root, "session.jsonl"), native.cwd);
  params.provider = provider;
  params.model = {
    ...params.model,
    provider,
    api: "openai-responses",
    baseUrl: "https://other.example.test/v1",
  };
  params.runtimePlan = {
    ...createCodexRuntimePlanFixture(),
    auth: {
      providerForAuth: provider,
      authProfileProviderForAuth: provider,
      selectedAuthMode: "native-command",
      credentialSource: { kind: "none" },
    },
  };
  let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
  let nativeMethods: () => string[] = () => [];
  try {
    await expect(
      runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: {
            command: native.command,
            args: ["app-server"],
            homeScope: "user",
            sandbox: "read-only",
            approvalPolicy: "never",
            clearEnv: Object.keys(process.env).filter((key) => !(key in native.env)),
          },
        },
        nativeHookRelay: { enabled: false },
        clientFactory: async (options) => {
          client = await createIsolatedCodexAppServerClient(options);
          const request = vi.spyOn(client, "request");
          nativeMethods = () => request.mock.calls.map(([method]) => method);
          return client;
        },
      }),
    ).rejects.toThrow("matching Codex model_providers entry");
    const methods = nativeMethods();
    expect(methods).toContain("config/read");
    expect(
      methods.some((method) => ["thread/start", "thread/resume", "turn/start"].includes(method)),
    ).toBe(false);
  } finally {
    if (client) {
      expect(await client.closeAndWait()).toMatchObject({ exited: true });
    }
  }
}, 45000);
