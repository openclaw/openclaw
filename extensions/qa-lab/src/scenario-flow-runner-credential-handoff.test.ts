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
  const { file, reply, migrate, unrelatedMigration } = options;
  const state = createQaBusState();
  const stateDir = "/qa/state";
  const providerPath = file?.path ?? path.join(stateDir, "secrets/key.txt");
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
            OPENCLAW_CONFIG_PATH: "/qa/openclaw.json",
            OPENCLAW_STATE_DIR: stateDir,
          },
        },
      },
      fs: {
        realpath: async (filePath: string) =>
          filePath === providerPath ? (file?.realPath ?? filePath) : filePath,
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
            mtimeMs: file?.mtimeMs ?? 100,
            mode: 0o100600,
            nlink: 1,
            isFile: () => file?.isFile ?? true,
          };
        },
      },
      runAgentPrompt: async (_env: unknown, params: { message: string }) => {
        const newKey = params.message.match(/sk-proj-QA-NEW-[\w-]+-NOT-A-REAL-KEY/)?.[0];
        if (!newKey) {
          throw new Error("operator request did not contain the new synthetic key");
        }
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
          secrets: file
            ? {
                providers: {
                  [provider]: {
                    source: "file",
                    path: providerPath,
                    mode: file.mode ?? "singleValue",
                  },
                },
              }
            : undefined,
          meta:
            migrate || unrelatedMigration
              ? {
                  migrations: unrelatedMigration
                    ? { unrelatedMarker: true }
                    : { modelPolicyAllowlist: true, utilityModelSeparation: true },
                }
              : undefined,
        })}`;
        const echo = reply === "sent-key-echo" || reply === "edited-key-echo";
        const preview = send(
          reply === "sent-key-echo"
            ? `Temporary echo: ${newKey}`
            : echo
              ? "Working."
              : "Working on the configuration.",
          echo ? 200 : 50,
        );
        if (reply === "edited-key-echo") {
          edit(preview.id, `Temporary echo: ${newKey}`, 250);
        }
        if (reply) {
          edit(preview.id, "Configuration updated.", 300);
        } else {
          state.deleteMessage({ accountId: "qa-channel", messageId: preview.id });
          send("Configuration updated.", 200);
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

  const errors = {
    ordering:
      "The assistant did not update the OpenClaw embeddings API key before the final reply.",
    migration: "The assistant changed unrelated OpenClaw configuration while rotating the key.",
    escaped: "The embeddings key file is outside the isolated QA Gateway state directory.",
    relative: "The embeddings key file provider path is not absolute.",
    symlink: "The embeddings key file is not a private regular file.",
    array: "The embeddings key file provider payload is not a JSON object.",
    provider: "The embeddings key references an invalid file provider.",
  };
  it.each([
    ["final predates config", { reply: "late-edited-final" }, errors.ordering],
    ["final predates key file", { file: { mtimeMs: 250 } }, errors.ordering],
    ["unrelated migration", { unrelatedMigration: true }, errors.migration],
    ["escaped file", { file: { realPath: "/outside/key.txt" } }, errors.escaped],
    ["relative path", { file: { path: "~/state/secrets/key.txt" } }, errors.relative],
    ["symlink", { file: { isFile: false } }, errors.symlink],
    ["array root", { file: { mode: "json", payload: (key: string) => [{ key }] } }, errors.array],
    ["invalid singleValue id", { file: { id: "wrong" } }, errors.provider],
    ["invalid provider alias", { file: { provider: "QA_KEY" } }, errors.provider],
    [
      "invalid JSON pointer escape",
      {
        file: {
          mode: "json",
          id: "/qa/~2key",
          payload: (key: string) => ({ qa: { "~2key": key } }),
        },
      },
      errors.provider,
    ],
  ] satisfies Array<[string, HandoffOptions, string]>)(
    "rejects %s",
    async (_label, options, error) => {
      await expect(runCredentialHandoffScenario(options)).rejects.toThrow(error);
    },
  );
});
