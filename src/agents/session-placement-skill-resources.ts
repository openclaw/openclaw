import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SkillResourceSourceReader, SkillSnapshot, SkillUsagePath } from "../skills/types.js";

type ResourceContext = {
  source: SkillSnapshot;
  snapshot: SkillSnapshot;
  mounts: Array<{ hostPath: string; containerPath: string }>;
  skillUsagePaths: SkillUsagePath[];
  skillResources?: Pick<SkillResourceSourceReader, "readInstructions">;
  resourceReadiness?: {
    wait: (signal: AbortSignal) => Promise<void>;
    assertCurrent: () => void;
  };
  assertCurrent: () => void;
};
const resources = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionSkillResources"),
  () => new AsyncLocalStorage<ResourceContext>(),
);

export function withSessionSkillResources<T>(
  context: ResourceContext,
  run: () => Promise<T>,
): Promise<T> {
  return resources.run(context, run);
}
export function resolveSessionSkillResourceSnapshot(
  source?: SkillSnapshot,
): SkillSnapshot | undefined {
  const context = resources.getStore();
  if (!context) {
    return source;
  }
  context.assertCurrent();
  if (source !== context.source && source !== context.snapshot) {
    throw new Error("Skill resources belong to a different prepared turn.");
  }
  return context.snapshot;
}
export function resolveSessionSkillResourceSandboxInputs() {
  const context = resources.getStore();
  context?.assertCurrent();
  return (
    context && {
      readOnlyResourceMounts: context.mounts,
      skillUsagePaths: context.skillUsagePaths,
      skillResources: context.skillResources,
      ...(context.resourceReadiness ? { resourceReadiness: context.resourceReadiness } : {}),
    }
  );
}
