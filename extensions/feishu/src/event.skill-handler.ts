import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeEnv } from "../runtime-api.js";
import type { FeishuLoadedSkillSubscriber } from "./event.skill-loader.js";
import type { FeishuEventSubscriptionMatch } from "./event.subscription.js";

const DEFAULT_FEISHU_SKILL_SUBSCRIBER_HANDLER_EXPORT = "handleFeishuEvent";

export type FeishuSkillSubscriberHandlerContext = {
  subscriptionId: string;
  skillName: string;
  filePath: string;
  delivery: FeishuEventSubscriptionMatch["delivery"];
  runtime?: Pick<RuntimeEnv, "log" | "error">;
};

export type FeishuSkillSubscriberHandler = (
  context: FeishuSkillSubscriberHandlerContext,
) => Promise<void> | void;

type LoadedFeishuSkillSubscriberHandler = {
  filePath: string;
  exportName: string;
  handler: FeishuSkillSubscriberHandler;
};

const feishuSkillSubscriberHandlerCache = new Map<
  string,
  Promise<LoadedFeishuSkillSubscriberHandler>
>();

function resolveSkillLocalPath(params: { skillBaseDir: string; relativePath: string }): string {
  const resolved = path.resolve(params.skillBaseDir, params.relativePath);
  const relative = path.relative(params.skillBaseDir, resolved);
  if (
    relative === "" ||
    relative === "." ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  throw new Error(`subscriber handler path escapes skill directory: ${params.relativePath}`);
}

function resolveHandlerCacheKey(filePath: string, exportName: string): string {
  return `${filePath}#${exportName}`;
}

export async function loadFeishuSkillSubscriberHandler(params: {
  skillBaseDir: string;
  handler: {
    file: string;
    exportName?: string;
  };
}): Promise<LoadedFeishuSkillSubscriberHandler> {
  const filePath = resolveSkillLocalPath({
    skillBaseDir: params.skillBaseDir,
    relativePath: params.handler.file,
  });
  const exportName =
    params.handler.exportName?.trim() || DEFAULT_FEISHU_SKILL_SUBSCRIBER_HANDLER_EXPORT;
  const cacheKey = resolveHandlerCacheKey(filePath, exportName);
  const cached = feishuSkillSubscriberHandlerCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const moduleUrl = pathToFileURL(filePath).href;
    const loadedModule = (await import(moduleUrl)) as Record<string, unknown>;
    const exportedHandler = loadedModule[exportName];
    if (typeof exportedHandler !== "function") {
      throw new Error(`subscriber handler export "${exportName}" is not a function in ${filePath}`);
    }
    return {
      filePath,
      exportName,
      handler: exportedHandler as FeishuSkillSubscriberHandler,
    };
  })();
  feishuSkillSubscriberHandlerCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    feishuSkillSubscriberHandlerCache.delete(cacheKey);
    throw error;
  }
}

export async function executeFeishuSkillSubscriberHandler(params: {
  entry: FeishuLoadedSkillSubscriber;
  match: FeishuEventSubscriptionMatch;
  runtime?: Pick<RuntimeEnv, "log" | "error">;
}): Promise<void> {
  const handlerSpec = params.entry.definition.handler;
  if (!handlerSpec) {
    return;
  }
  const loaded = await loadFeishuSkillSubscriberHandler({
    skillBaseDir: params.entry.source.skillBaseDir,
    handler: handlerSpec,
  });
  await loaded.handler({
    subscriptionId: params.match.subscriptionId,
    skillName: params.entry.source.skillName,
    filePath: loaded.filePath,
    delivery: params.match.delivery,
    runtime: params.runtime,
  });
}

export function clearFeishuSkillSubscriberHandlerCacheForTest(): void {
  feishuSkillSubscriberHandlerCache.clear();
}
