import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { d as ContextVisibilityMode } from "./types.base-BV0Xx5AM.js";
//#region src/config/context-visibility.d.ts
type ContextVisibilityDefaultsConfig = {
  channels?: {
    defaults?: {
      contextVisibility?: ContextVisibilityMode;
    };
  };
};
declare function resolveDefaultContextVisibility(cfg: ContextVisibilityDefaultsConfig): ContextVisibilityMode | undefined;
declare function resolveChannelContextVisibilityMode(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  configuredContextVisibility?: ContextVisibilityMode;
}): ContextVisibilityMode;
//#endregion
export { resolveDefaultContextVisibility as n, resolveChannelContextVisibilityMode as t };