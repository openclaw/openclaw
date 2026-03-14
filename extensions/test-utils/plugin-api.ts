type TestLogger = {
  info: () => void;
  warn: () => void;
  error: () => void;
  debug?: () => void;
};

type TestPluginApiDefaults = {
  logger: TestLogger;
  registerTool: () => void;
  registerHook: () => void;
  registerHttpRoute: () => void;
  registerChannel: () => void;
  registerGatewayMethod: () => void;
  registerCli: () => void;
  registerService: () => void;
  registerProvider: () => void;
  registerCommand: () => void;
  registerContextEngine: () => void;
  resolvePath: (input: string) => string;
  on: () => void;
};

export function createTestPluginApi<T extends object>(api: T): T & TestPluginApiDefaults {
  return {
    logger: { info() {}, warn() {}, error() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
    ...api,
  };
}
