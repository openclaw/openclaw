import type { OpenClawPluginApi } from "../../src/plugins/types.js";

type TestPluginApiInput = Partial<OpenClawPluginApi> &
  Pick<OpenClawPluginApi, "id" | "name" | "source" | "config" | "runtime">;

export function createTestPluginApi(api: TestPluginApiInput): OpenClawPluginApi {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
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
