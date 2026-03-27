import { readSnakeCaseParamRaw } from "../param-key.js";
import { copyPluginToolMeta } from "../plugins/tools.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import type { AnyAgentTool } from "./tools/common.js";

type ThreadInjectionKey = "threadId" | "messageThreadId";

function coerceAmbientThreadIdForSchema(params: {
  value: unknown;
  expectedType?: "string" | "number";
}): string | number | undefined {
  const { value, expectedType } = params;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (expectedType === "string") {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed || undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return undefined;
  }
  if (expectedType === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    if (/^-?\d+$/.test(trimmed) && !Number.isSafeInteger(parsed)) {
      return undefined;
    }
    return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function resolveThreadInjectionTarget(tool: AnyAgentTool): {
  key: ThreadInjectionKey;
  expectedType?: "string" | "number";
} | null {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : null;
  const properties =
    schema?.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : null;
  if (!properties) {
    return null;
  }
  for (const key of ["threadId", "messageThreadId"] as const) {
    const property =
      properties[key] && typeof properties[key] === "object"
        ? (properties[key] as Record<string, unknown>)
        : null;
    if (!property) {
      continue;
    }
    const type = property.type;
    const expectedType =
      type === "string" ? "string" : type === "number" || type === "integer" ? "number" : undefined;
    return { key, expectedType };
  }
  return null;
}

function wrapPluginToolWithAmbientThreadDefaults(params: {
  tool: AnyAgentTool;
  ambientThreadId: string | number;
}): AnyAgentTool {
  const target = resolveThreadInjectionTarget(params.tool);
  if (!params.tool.execute || !target) {
    return params.tool;
  }
  const defaultThreadId = coerceAmbientThreadIdForSchema({
    value: params.ambientThreadId,
    expectedType: target.expectedType,
  });
  if (defaultThreadId === undefined) {
    return params.tool;
  }
  const originalExecute = params.tool.execute.bind(params.tool);
  const wrappedTool: AnyAgentTool = {
    ...params.tool,
    execute: async (...args: unknown[]) => {
      const existingParams = args[1];
      const paramsRecord =
        existingParams == null
          ? {}
          : existingParams && typeof existingParams === "object" && !Array.isArray(existingParams)
            ? (existingParams as Record<string, unknown>)
            : null;
      if (!paramsRecord) {
        return await originalExecute(...(args as Parameters<typeof originalExecute>));
      }
      if (
        readSnakeCaseParamRaw(paramsRecord, "threadId") !== undefined ||
        readSnakeCaseParamRaw(paramsRecord, "messageThreadId") !== undefined
      ) {
        return await originalExecute(...(args as Parameters<typeof originalExecute>));
      }
      const nextArgs = [...args];
      nextArgs[1] = { ...paramsRecord, [target.key]: defaultThreadId };
      return await originalExecute(...(nextArgs as Parameters<typeof originalExecute>));
    },
  };
  copyPluginToolMeta(params.tool, wrappedTool);
  return wrappedTool;
}

export function applyPluginToolDeliveryDefaults(params: {
  tools: AnyAgentTool[];
  deliveryContext?: DeliveryContext;
}): AnyAgentTool[] {
  const ambientThreadId = params.deliveryContext?.threadId;
  if (ambientThreadId == null) {
    return params.tools;
  }
  return params.tools.map((tool) =>
    wrapPluginToolWithAmbientThreadDefaults({
      tool,
      ambientThreadId,
    }),
  );
}
