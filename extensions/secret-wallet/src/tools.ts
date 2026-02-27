import { Type } from "@sinclair/typebox";
import { runSecretWallet } from "./runner.js";

export type PluginConfig = {
  binaryPath?: string;
};

export function createSecretWalletReadTools(config: PluginConfig) {
  return [createStatusTool(config), createListTool(config), createGetTool(config)];
}

export function createSecretWalletWriteTools(config: PluginConfig) {
  return [createAddTool(config), createRemoveTool(config)];
}

export function createSecretWalletInjectTool(config: PluginConfig) {
  return createInjectTool(config);
}

function createStatusTool(config: PluginConfig) {
  return {
    name: "secret_wallet_status",
    description:
      "Check Secret Wallet status: version, biometric availability, and total secret count.",
    parameters: Type.Object({}),

    async execute() {
      const result = await runSecretWallet(config.binaryPath, ["status"]);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Secret Wallet error: ${result.error}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: result.stdout }],
      };
    },
  };
}

function createListTool(config: PluginConfig) {
  return {
    name: "secret_wallet_list",
    description:
      "List stored secrets via Secret Wallet. Returns metadata only (name/env mapping/biometric).",
    parameters: Type.Object({}),

    async execute() {
      const result = await runSecretWallet(config.binaryPath, ["list", "--json"]);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Failed to list secrets: ${result.error}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: result.stdout }],
      };
    },
  };
}

function createGetTool(config: PluginConfig) {
  return {
    name: "secret_wallet_get",
    description: "Get one secret value by name from Secret Wallet (may trigger Touch ID prompt).",
    parameters: Type.Object({
      name: Type.String({ description: "Secret name to read" }),
    }),

    async execute(_id: string, params: { name: string }) {
      const result = await runSecretWallet(config.binaryPath, ["get", params.name]);
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get secret '${params.name}': ${result.error}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: result.stdout }],
      };
    },
  };
}

function createAddTool(config: PluginConfig) {
  return {
    name: "secret_wallet_add",
    description: "Add a secret to Secret Wallet (stored in macOS Keychain).",
    parameters: Type.Object({
      name: Type.String({ description: "Secret name (for example OPENAI_KEY)" }),
      value: Type.String({ description: "Secret value" }),
      envName: Type.Optional(Type.String({ description: "Optional env var mapping" })),
      biometric: Type.Optional(Type.Boolean({ description: "Require biometric auth for reads" })),
    }),

    async execute(
      _id: string,
      params: { name: string; value: string; envName?: string; biometric?: boolean },
    ) {
      const args = ["add", params.name];
      if (params.envName) {
        args.push("--env-name", params.envName);
      }
      if (params.biometric) {
        args.push("--biometric");
      }

      const result = await runSecretWallet(config.binaryPath, args, {
        stdin: params.value,
      });

      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to store secret '${params.name}': ${result.error}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Secret '${params.name}' stored successfully.` }],
      };
    },
  };
}

function createRemoveTool(config: PluginConfig) {
  return {
    name: "secret_wallet_remove",
    description: "Remove a secret from Secret Wallet.",
    parameters: Type.Object({
      name: Type.String({ description: "Secret name to delete" }),
    }),

    async execute(_id: string, params: { name: string }) {
      const result = await runSecretWallet(config.binaryPath, ["remove", params.name]);
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to remove secret '${params.name}': ${result.error}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Secret '${params.name}' removed.` }],
      };
    },
  };
}

function createInjectTool(config: PluginConfig) {
  return {
    name: "secret_wallet_inject",
    description:
      "Run a command with only selected secrets injected via --only filters. Does not load all secrets by default.",
    parameters: Type.Object({
      command: Type.Array(Type.String(), {
        minItems: 1,
        description: "Command and arguments (for example ['node', 'server.js'])",
      }),
      secretNames: Type.Array(Type.String(), {
        minItems: 1,
        description: "Secret names to inject (mapped to repeated --only flags)",
      }),
    }),

    async execute(_id: string, params: { command: string[]; secretNames: string[] }) {
      if (params.command.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No command specified for injection." }],
        };
      }
      if (params.secretNames.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Provide at least one secret name." }],
        };
      }

      const args = ["inject"];
      for (const name of params.secretNames) {
        args.push("--only", name);
      }
      args.push("--", ...params.command);

      const result = await runSecretWallet(config.binaryPath, args, {
        timeoutMs: 120_000,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Inject failed: ${result.error}` }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: result.stdout || "Command executed with selected secrets.",
          },
        ],
      };
    },
  };
}
