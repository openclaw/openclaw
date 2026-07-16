import "./media-understanding-provider.js";
import "./session-catalog-plugin.js";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";

const mediaApi = Reflect.get(globalThis, Symbol.for("openclaw.opencodeMediaTestApi"));
const catalogApi = Reflect.get(globalThis, Symbol.for("openclaw.opencodeSessionCatalogTestApi"));
if (!mediaApi || !catalogApi) {
  throw new Error("OpenCode test API is unavailable");
}

export const { stripOpencodeDisabledResponsesReasoningPayload } = mediaApi as {
  stripOpencodeDisabledResponsesReasoningPayload: (payload: unknown) => void;
};

export const {
  createOpenCodeSessionNodeHostCommands,
  createOpenCodeSessionNodeInvokePolicies,
  isOpenCodeSessionCatalogEnabled,
} = catalogApi as {
  createOpenCodeSessionNodeHostCommands: () => OpenClawPluginNodeHostCommand[];
  createOpenCodeSessionNodeInvokePolicies: () => OpenClawPluginNodeInvokePolicy[];
  isOpenCodeSessionCatalogEnabled: (config: unknown) => boolean;
};
