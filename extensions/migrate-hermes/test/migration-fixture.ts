import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach } from "vitest";
import { makeContext, makeHermesPaths, writeFile } from "./provider-helpers.js";

export async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value));
}

export function configRuntime(config: Record<string, unknown>) {
  return {
    config: {
      current: () => config,
      mutateConfigFile: async ({
        mutate,
      }: {
        mutate: (draft: Record<string, unknown>) => void | Promise<void>;
      }) => {
        const next = structuredClone(config);
        await mutate(next);
        for (const key of Object.keys(config)) {
          delete config[key];
        }
        Object.assign(config, next);
        return { nextConfig: next };
      },
    },
  } as never;
}

export function useHermesFixture(cleanup?: (root: string) => void | Promise<void>) {
  let workspace: TempWorkspace;
  let paths: ReturnType<typeof makeHermesPaths>;
  beforeEach(async () => {
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-migrate-hermes-",
    });
    paths = makeHermesPaths(workspace.dir);
  });
  afterEach(async () => {
    await cleanup?.(workspace.dir);
    await workspace.cleanup();
  });
  return {
    get paths() {
      return paths;
    },
    context: (overrides: Partial<Parameters<typeof makeContext>[0]> = {}) => {
      const { source, stateDir, workspaceDir } = paths;
      return makeContext({ source, stateDir, workspaceDir, ...overrides });
    },
  };
}
