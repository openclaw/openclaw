import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

function configWithKey(apiKey: string | { source: string; provider: string; id: string }) {
  return {
    gateway: { mode: "local" },
    memory: {
      search: {
        enabled: false,
        provider: "openai-compatible",
        remote: { baseUrl: "https://memory.example.invalid/v1/", apiKey },
      },
    },
  };
}

type HandoffOptions = {
  reply?: "sent-key-echo" | "edited-key-echo" | "late-edited-final";
  file?: {
    mode?: "json";
    id?: string;
    provider?: string;
    path?: string;
    realPath?: string;
    isFile?: boolean;
    mtimeMs?: number;
    payload?: (key: string) => unknown;
  };
  migrate?: boolean;
  unrelatedMigration?: boolean;
};

async function runCredentialHandoffScenario(options: HandoffOptions = {}) {
  const state = createQaBusState();
  const stateDir = "/qa/state";
  const providerPath = options.file?.path ?? path.join(stateDir, "secrets/key.txt");
  const scenario = readQaScenarioById("operator-api-key-handoff-live");
  const oldKey = scenario.execution.config?.oldKey;
  if (typeof oldKey !== "string") {
    throw new Error("credential handoff scenario needs an old synthetic key");
  }
  let configText = JSON.stringify(configWithKey(oldKey));
  let secretFile = "";
  const send = (text: string, timestamp: number) =>
    state.addOutboundMessage({
      accountId: "qa-channel",
      to: "dm:operator-key-rotation",
      text,
      timestamp,
    });
  const edit = (messageId: string, text: string, timestamp: number) =>
    state.editMessage({
      accountId: "qa-channel",
      messageId,
      text,
      timestamp,
    });
  const result = await runLoadedScenarioFlow(scenario.id, {
    state,
    api: {
      path,
      env: {
        providerMode: "live-frontier",
        gateway: {
          runtimeEnv: {
            HOME: "/qa",
            OPENCLAW_CONFIG_PATH: "/qa/openclaw.json",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_QA_TEMP_ROOT: "/qa",
          },
        },
      },
      fs: {
        realpath: async (filePath: string) =>
          filePath === providerPath ? (options.file?.realPath ?? filePath) : filePath,
        readFile: async (filePath: string) => {
          if (filePath === "/qa/openclaw.json") {
            return configText;
          }
          if (filePath === providerPath) {
            return secretFile;
          }
          throw new Error(`unexpected QA file read: ${filePath}`);
        },
        stat: async (filePath: string) => {
          expect(filePath).toBe("/qa/openclaw.json");
          return { mtimeMs: 100 };
        },
        lstat: async (filePath: string) => {
          expect(filePath).toBe(providerPath);
          return {
            mtimeMs: options.file?.mtimeMs ?? 100,
            mode: 0o100600,
            nlink: 1,
            isFile: () => options.file?.isFile ?? true,
          };
        },
      },
      runAgentPrompt: async (_env: unknown, params: { message: string }) => {
        const newKey = params.message.match(/sk-proj-QA-NEW-[\w-]+-NOT-A-REAL-KEY/)?.[0];
        if (!newKey) {
          throw new Error("operator request did not contain the new synthetic key");
        }
        const file = options.file;
        const provider = file?.provider ?? "qa_key";
        const config = configWithKey(
          file
            ? {
                source: "file",
                provider,
                id: file.id ?? (file.mode === "json" ? "/qa/key" : "value"),
              }
            : newKey,
        );
        secretFile =
          file?.mode === "json"
            ? JSON.stringify(file.payload ? file.payload(newKey) : { qa: { key: newKey } })
            : `${newKey}\n`;
        configText = `// operator-authored config\n${JSON.stringify({
          ...config,
          ...(file
            ? {
                secrets: {
                  providers: {
                    [provider]: {
                      source: "file",
                      path: providerPath,
                      mode: file.mode ?? "singleValue",
                    },
                  },
                },
              }
            : {}),
          ...(options.migrate || options.unrelatedMigration
            ? {
                meta: {
                  migrations: options.unrelatedMigration
                    ? { unrelatedMarker: true }
                    : { modelPolicyAllowlist: true, utilityModelSeparation: true },
                },
              }
            : {}),
        })}`;
        if (options.reply === "sent-key-echo" || options.reply === "edited-key-echo") {
          const message = send(
            options.reply === "sent-key-echo" ? `Temporary echo: ${newKey}` : "Working.",
            200,
          );
          if (options.reply === "edited-key-echo") {
            edit(message.id, `Temporary echo: ${newKey}`, 250);
          }
          edit(message.id, "Configuration updated.", 300);
        } else {
          const preview = send("Working on the configuration.", 50);
          if (options.reply === "late-edited-final") {
            edit(preview.id, "Configuration updated.", 300);
          } else {
            state.deleteMessage({ accountId: "qa-channel", messageId: preview.id });
            send("Configuration updated.", 200);
          }
        }
      },
      waitForOutboundMessage: async (...args: Parameters<typeof waitForOutboundMessage>) => {
        const [transportState, predicate, , waitOptions] = args;
        return await waitForOutboundMessage(transportState, predicate, 10, waitOptions);
      },
    },
  });
  return { result, state };
}

describe("operator key handoff scenario assertions", () => {
  it.each(["sent-key-echo", "edited-key-echo"] as const)(
    "rejects %s even when edited away",
    async (reply) => {
      await expect(runCredentialHandoffScenario({ reply })).rejects.toThrow(
        "The assistant repeated a key",
      );
    },
  );

  it("accepts config migrations and a deleted preview followed by one durable final", async () => {
    const { result, state } = await runCredentialHandoffScenario({ migrate: true });
    expect(result.status).toBe("pass");
    expect(result.steps[0]?.details).toBe("configUpdated=true; outboundCount=1; keyEcho=false");
    expect(state.getSnapshot().messages.map((message) => message.deleted === true)).toEqual([
      true,
      false,
    ]);
  });

  it.each(["singleValue", "json"] as const)(
    "accepts a %s file resolving to the supplied key",
    async (mode) => {
      const { result } = await runCredentialHandoffScenario({
        file: mode === "json" ? { mode } : {},
      });
      expect(result.status).toBe("pass");
      expect(result.steps[0]?.details).toBe("configUpdated=true; outboundCount=1; keyEcho=false");
    },
  );

  it.each([
    [
      "final predates config",
      { reply: "late-edited-final" },
      "The assistant did not update the OpenClaw embeddings API key before the final reply.",
    ],
    [
      "final predates key file",
      { file: { mtimeMs: 250 } },
      "The assistant did not update the OpenClaw embeddings API key before the final reply.",
    ],
    [
      "unrelated migration",
      { unrelatedMigration: true },
      "The assistant changed unrelated OpenClaw configuration while rotating the key.",
    ],
    [
      "escaped file",
      { file: { realPath: "/outside/key.txt" } },
      "The embeddings key file is outside the isolated QA Gateway state directory.",
    ],
    [
      "relative path",
      { file: { path: "~/state/secrets/key.txt" } },
      "The embeddings key file provider path is not absolute.",
    ],
    [
      "symlink",
      { file: { isFile: false } },
      "The embeddings key file is not a private regular file.",
    ],
    [
      "array root",
      { file: { mode: "json", payload: (key: string) => [{ key }] } },
      "The embeddings key file provider payload is not a JSON object.",
    ],
    [
      "invalid singleValue id",
      { file: { id: "wrong" } },
      "The embeddings key references an invalid file provider.",
    ],
    [
      "invalid provider alias",
      { file: { provider: "QA_KEY" } },
      "The embeddings key references an invalid file provider.",
    ],
    [
      "invalid JSON pointer escape",
      {
        file: {
          mode: "json",
          id: "/qa/~2key",
          payload: (key: string) => ({ qa: { "~2key": key } }),
        },
      },
      "The embeddings key references an invalid file provider.",
    ],
  ] satisfies Array<[string, HandoffOptions, string]>)(
    "rejects %s",
    async (_label, options, error) => {
      await expect(runCredentialHandoffScenario(options)).rejects.toThrow(error);
    },
  );
});
