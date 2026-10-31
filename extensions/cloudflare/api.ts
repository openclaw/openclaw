import type { StorageProvider } from "openclaw/plugin-sdk/plugin-entry";
import { describeR2Target, validateR2Settings } from "./settings.js";

export const r2StorageProvider: StorageProvider = {
  id: "r2",
  label: "Cloudflare R2",
  validateSettings: validateR2Settings,
  describeTarget: describeR2Target,
  async open(params) {
    const { openR2Backend } = await import("./runtime-api.js");
    return openR2Backend(params);
  },
};
