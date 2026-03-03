import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
export function splitSdkTools(options) {
    const { tools } = options;
    return {
        builtInTools: [],
        customTools: toToolDefinitions(tools),
    };
}
