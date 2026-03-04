/**
 * Type stubs for openclaw/plugin-sdk.
 *
 * These types allow the extension to compile standalone (outside the OpenClaw monorepo).
 * When installed as a plugin inside OpenClaw, these are overridden by the real SDK types.
 */

export interface OpenClawPluginApi {
  runtime: {
    config: {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (config: Record<string, unknown>) => Promise<void>;
    };
    paths?: {
      stateDir: string;
    };
  };
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
  registerChannel: (opts: { plugin: unknown }) => void;
  registerHttpHandler: (handler: {
    prefix: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: (req: any, res: any) => Promise<void>;
  }) => void;
}

export interface PluginConfigSchema {
  type: "object";
  additionalProperties: boolean;
  properties: Record<string, unknown>;
}

export function emptyPluginConfigSchema(): PluginConfigSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}
