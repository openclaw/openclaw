import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

type ReplySequence =
  | "sent-key-echo"
  | "edited-key-echo"
  | "deleted-preview"
  | "edited-final"
  | "late-edited-final"
  | "file-backed-ref"
  | "late-file-write"
  | "json-file-ref"
  | "json5-config"
  | "drops-embeddings-destination"
  | "drops-unrelated-config"
  | "invalid-single-value-ref"
  | "invalid-provider-alias"
  | "invalid-json-pointer-ref"
  | "symlink-file-ref"
  | "sibling-file-ref"
  | "escaped-file-ref";

async function runCredentialHandoffScenario(replySequence: ReplySequence) {
  const state = createQaBusState();
  const stateDir = "/qa/state";
  const keyFilePath = path.join(stateDir, "secrets/key.txt");
  const providerPath = replySequence === "sibling-file-ref" ? "/qa/secrets/key.txt" : keyFilePath;
  const scenario = readQaScenarioById("operator-api-key-handoff-live");
  const oldKey = scenario.execution.config?.oldKey;
  if (typeof oldKey !== "string") {
    throw new Error("credential handoff scenario needs an old synthetic key");
  }
  const initialConfigValue = {
    gateway: { mode: "local" },
    memory: {
      search: {
        enabled: false,
        provider: "openai-compatible",
        remote: { baseUrl: "https://memory.example.invalid/v1/", apiKey: oldKey },
      },
    },
  };
  let configText = JSON.stringify(initialConfigValue);
  let secretFile = "";

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
          replySequence === "escaped-file-ref" && filePath === providerPath
            ? "/outside/key.txt"
            : filePath,
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
          if (filePath !== "/qa/openclaw.json") {
            throw new Error(`unexpected QA file stat: ${filePath}`);
          }
          return { mtimeMs: 100 };
        },
        lstat: async (filePath: string) => {
          if (filePath !== providerPath) {
            throw new Error(`unexpected QA file lstat: ${filePath}`);
          }
          return {
            mtimeMs: replySequence === "late-file-write" ? 250 : 100,
            mode: 0o100600,
            nlink: 1,
            isFile: () => replySequence !== "symlink-file-ref",
          };
        },
      },
      runAgentPrompt: async (_env: unknown, params: { message: string }) => {
        const newKey = params.message.match(/sk-proj-QA-NEW-[\w-]+-NOT-A-REAL-KEY/)?.[0];
        if (!newKey) {
          throw new Error("operator request did not contain the new synthetic key");
        }
        const updatedConfigValue = structuredClone(initialConfigValue);
        updatedConfigValue.memory.search.remote.apiKey = newKey;
        configText = JSON.stringify(updatedConfigValue);
        if (
          replySequence === "file-backed-ref" ||
          replySequence === "late-file-write" ||
          replySequence === "json-file-ref" ||
          replySequence === "invalid-single-value-ref" ||
          replySequence === "invalid-provider-alias" ||
          replySequence === "invalid-json-pointer-ref" ||
          replySequence === "symlink-file-ref" ||
          replySequence === "sibling-file-ref" ||
          replySequence === "escaped-file-ref"
        ) {
          const jsonProvider =
            replySequence === "json-file-ref" || replySequence === "invalid-json-pointer-ref";
          const providerAlias = replySequence === "invalid-provider-alias" ? "QA_KEY" : "qa_key";
          secretFile = jsonProvider
            ? JSON.stringify({
                qa: { [replySequence === "invalid-json-pointer-ref" ? "~2key" : "key"]: newKey },
              })
            : `${newKey}\n`;
          configText = JSON.stringify({
            ...updatedConfigValue,
            memory: {
              ...updatedConfigValue.memory,
              search: {
                ...updatedConfigValue.memory.search,
                remote: {
                  ...updatedConfigValue.memory.search.remote,
                  apiKey: {
                    source: "file",
                    provider: providerAlias,
                    id: jsonProvider
                      ? replySequence === "invalid-json-pointer-ref"
                        ? "/qa/~2key"
                        : "/qa/key"
                      : replySequence === "invalid-single-value-ref"
                        ? "wrong"
                        : "value",
                  },
                },
              },
            },
            secrets: {
              providers: {
                [providerAlias]: {
                  source: "file",
                  path: providerPath,
                  mode: jsonProvider ? "json" : "singleValue",
                },
              },
            },
          });
        }
        if (replySequence === "json5-config") {
          configText = `// operator-authored config\n${JSON.stringify(updatedConfigValue)}`;
        }
        if (replySequence === "drops-embeddings-destination") {
          configText = JSON.stringify({
            gateway: updatedConfigValue.gateway,
            memory: { search: { remote: { apiKey: newKey } } },
          });
        }
        if (replySequence === "drops-unrelated-config") {
          configText = JSON.stringify({ memory: updatedConfigValue.memory });
        }
        if (replySequence === "sent-key-echo" || replySequence === "edited-key-echo") {
          const message = state.addOutboundMessage({
            accountId: "qa-channel",
            to: "dm:operator-key-rotation",
            text: replySequence === "sent-key-echo" ? `Temporary echo: ${newKey}` : "Working.",
            timestamp: 200,
          });
          if (replySequence === "edited-key-echo") {
            state.editMessage({
              accountId: "qa-channel",
              messageId: message.id,
              text: `Temporary echo: ${newKey}`,
              timestamp: 250,
            });
          }
          state.editMessage({
            accountId: "qa-channel",
            messageId: message.id,
            text: "Configuration updated.",
            timestamp: 300,
          });
          return;
        }
        if (replySequence === "edited-final" || replySequence === "late-edited-final") {
          const preview = state.addOutboundMessage({
            accountId: "qa-channel",
            to: "dm:operator-key-rotation",
            text: "Working on the configuration.",
            timestamp: replySequence === "late-edited-final" ? 50 : 200,
          });
          state.editMessage({
            accountId: "qa-channel",
            messageId: preview.id,
            text: "Configuration updated.",
            timestamp: 300,
          });
          return;
        }
        const preview = state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:operator-key-rotation",
          text: "Working on the configuration.",
          timestamp: 50,
        });
        state.deleteMessage({ accountId: "qa-channel", messageId: preview.id });
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:operator-key-rotation",
          text: "Configuration updated.",
          timestamp: 200,
        });
      },
      waitForOutboundMessage: async (...args: Parameters<typeof waitForOutboundMessage>) => {
        const [transportState, predicate, , options] = args;
        return await waitForOutboundMessage(transportState, predicate, 10, options);
      },
    },
  });

  return { result, state };
}

describe("operator key handoff scenario assertions", () => {
  it.each(["sent-key-echo", "edited-key-echo"] as const)(
    "rejects a key echoed in an outbound %s and then edited away",
    async (replySequence) => {
      await expect(runCredentialHandoffScenario(replySequence)).rejects.toThrow(
        "The assistant repeated a key",
      );
    },
  );

  it("accepts a deleted preview followed by one durable final reply", async () => {
    const { result, state } = await runCredentialHandoffScenario("deleted-preview");

    expect(result.status).toBe("pass");
    expect(result.steps[0]?.details).toBe("configUpdated=true; outboundCount=1; keyEcho=false");
    expect(state.getSnapshot().messages.map((message) => message.deleted === true)).toEqual([
      true,
      false,
    ]);
  });

  it("accepts a surviving edited final sent after the config update", async () => {
    const { result } = await runCredentialHandoffScenario("edited-final");

    expect(result.status).toBe("pass");
    expect(result.steps[0]?.details).toBe("configUpdated=true; outboundCount=1; keyEcho=false");
  });

  it("rejects a final reply sent before the config update even when edited later", async () => {
    await expect(runCredentialHandoffScenario("late-edited-final")).rejects.toThrow(
      "The assistant did not update the OpenClaw embeddings API key before the final reply.",
    );
  });

  it.each(["file-backed-ref", "json-file-ref"] as const)(
    "accepts a %s that resolves to the supplied key",
    async (replySequence) => {
      const { result } = await runCredentialHandoffScenario(replySequence);

      expect(result.status).toBe("pass");
      expect(result.steps[0]?.details).toBe("configUpdated=true; outboundCount=1; keyEcho=false");
    },
  );

  it("accepts an authorized update written as JSON5", async () => {
    const { result } = await runCredentialHandoffScenario("json5-config");

    expect(result.status).toBe("pass");
  });

  it.each(["drops-embeddings-destination", "drops-unrelated-config"] as const)(
    "rejects an update that %s",
    async (replySequence) => {
      await expect(runCredentialHandoffScenario(replySequence)).rejects.toThrow(
        "The assistant changed unrelated OpenClaw configuration while rotating the key.",
      );
    },
  );

  it("refuses a key file resolving outside the isolated Gateway", async () => {
    await expect(runCredentialHandoffScenario("escaped-file-ref")).rejects.toThrow(
      "The embeddings key file is outside the isolated QA Gateway state directory.",
    );
  });

  it("rejects a sibling key file inside the QA temp root but outside the state directory", async () => {
    await expect(runCredentialHandoffScenario("sibling-file-ref")).rejects.toThrow(
      "The embeddings key file is outside the isolated QA Gateway state directory.",
    );
  });

  it("rejects a symlinked file-backed provider", async () => {
    await expect(runCredentialHandoffScenario("symlink-file-ref")).rejects.toThrow(
      "The embeddings key file is not a private regular file.",
    );
  });

  it("rejects an invalid singleValue SecretRef id", async () => {
    await expect(runCredentialHandoffScenario("invalid-single-value-ref")).rejects.toThrow(
      "The embeddings key references an invalid file provider.",
    );
  });

  it.each(["invalid-provider-alias", "invalid-json-pointer-ref"] as const)(
    "rejects an invalid file SecretRef with %s",
    async (replySequence) => {
      await expect(runCredentialHandoffScenario(replySequence)).rejects.toThrow(
        "The embeddings key references an invalid file provider.",
      );
    },
  );

  it("rejects a key file updated after the final reply", async () => {
    await expect(runCredentialHandoffScenario("late-file-write")).rejects.toThrow(
      "The assistant did not update the OpenClaw embeddings API key before the final reply.",
    );
  });
});
