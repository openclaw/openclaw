import path from "node:path";
import type { MigrationPlan } from "openclaw/plugin-sdk/plugin-entry";
import { buildHermesMigrationProvider } from "../provider.js";
import { readAuthProfileStore } from "./auth-helpers.js";
import { writeJson } from "./migration-fixture.js";
import { makeConfigRuntime, makeContext, makeHermesPaths, writeFile } from "./provider-helpers.js";

type Options = Partial<Parameters<typeof makeContext>[0]>;

export function hermesCase(root: string, includeSecrets = false, sourceName = "hermes") {
  const paths = makeHermesPaths(root, sourceName);
  const config = makeContext(paths).config;
  const runtime = makeConfigRuntime(config);
  const provider = buildHermesMigrationProvider();
  const context = (options: Options = {}) => makeContext({ ...paths, includeSecrets, ...options });
  const apply = (options: Options = {}, plan?: MigrationPlan) =>
    provider.apply(context(options), plan);
  return {
    ...paths,
    config,
    runtime,
    provider,
    context,
    apply,
    plan: (options: Options = {}) => provider.plan(context(options)),
    import: (options: Options = {}, plan?: MigrationPlan) =>
      apply({ config, runtime, ...options }, plan),
    write: (relative: string, content: string | object) =>
      writeFile(
        path.join(paths.source, relative),
        typeof content === "string" ? content : JSON.stringify(content),
      ),
    openCode: (value: unknown) =>
      writeJson(path.join(root, ".local", "share", "opencode", "auth.json"), value),
    profiles: () => readAuthProfileStore(paths.agentDir).profiles,
  };
}

export function item(plan: MigrationPlan, id: string) {
  return plan.items.find((entry) => entry.id === id);
}
