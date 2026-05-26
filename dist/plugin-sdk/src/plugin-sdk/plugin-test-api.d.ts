import type { OpenClawPluginApi } from "./plugin-runtime.js";
export type TestPluginApiInput = Partial<OpenClawPluginApi>;
export declare function createTestPluginApi(api?: TestPluginApiInput): OpenClawPluginApi;
