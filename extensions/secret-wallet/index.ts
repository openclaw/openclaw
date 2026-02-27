import {
  createSecretWalletInjectTool,
  createSecretWalletReadTools,
  createSecretWalletWriteTools,
} from "./src/tools.js";

type ToolContext = {
  sandboxed?: boolean;
};

type Tool = {
  name: string;
  [key: string]: unknown;
};

type PluginApi = {
  pluginConfig?: unknown;
  registerTool: (
    factory: (ctx: ToolContext) => Tool | null,
    options?: { optional?: boolean },
  ) => void;
};

export default function register(api: PluginApi) {
  const config = (api.pluginConfig ?? {}) as {
    binaryPath?: string;
    allowWriteTools?: boolean;
    allowInjectTool?: boolean;
  };

  const readTools = createSecretWalletReadTools(config);
  const writeTools = createSecretWalletWriteTools(config);
  const injectTool = createSecretWalletInjectTool(config);

  for (const tool of readTools) {
    api.registerTool((ctx) => {
      if (ctx.sandboxed) return null;
      return tool;
    });
  }

  if (config.allowWriteTools) {
    for (const tool of writeTools) {
      api.registerTool(
        (ctx) => {
          if (ctx.sandboxed) return null;
          return tool;
        },
        { optional: true },
      );
    }
  }

  if (config.allowInjectTool) {
    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) return null;
        return injectTool;
      },
      { optional: true },
    );
  }
}
