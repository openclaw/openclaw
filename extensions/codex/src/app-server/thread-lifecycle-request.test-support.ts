import { vi } from "vitest";
import type { JsonObject } from "./protocol.js";

export function createLifecycleRequest(
  respond: (method: string, requestParams?: unknown) => Promise<unknown>,
  effectiveConfig: JsonObject = {},
) {
  return vi.fn((method: string, requestParams?: unknown) => {
    if (method === "config/read") {
      return Promise.resolve({ config: effectiveConfig, origins: {}, layers: [] });
    }
    if (method === "configRequirements/read") {
      return Promise.resolve({ requirements: null });
    }
    return respond(method, requestParams);
  });
}
