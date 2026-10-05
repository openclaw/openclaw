import { fileURLToPath } from "node:url";
import type { UserConfig } from "tsdown";
import { packageActivationRuntimeEntrypoint } from "../../src/infra/package-update-activation-runtime-assets.ts";
import { managedHandoffRuntimeEntrypoint } from "../../src/infra/update-managed-service-handoff-runtime-assets.ts";
import { createStateSchemaInlinePlugin } from "./state-schema-inline-plugin.mts";

/** Hidden companion maps preserve runtime bytes without an executable source-map hook. */
export const OUTPUT_SOURCE_MAPS =
  process.env.OUTPUT_SOURCE_MAPS === "hidden" ? "hidden" : process.env.OUTPUT_SOURCE_MAPS === "1";

type SealedRecoveryBuildConfig = Omit<UserConfig, "entry"> & { entry: Record<string, string> };

/** The installed CLI and invocation compiler seal the same typed lease owner. */
export function createManagedHandoffBuildConfigs(): SealedRecoveryBuildConfig[] {
  return [managedHandoffRuntimeEntrypoint, packageActivationRuntimeEntrypoint].map((entry) =>
    createSealedRecoveryBuildConfig(entry),
  );
}

export function createSealedRecoveryBuildConfig(
  entry: typeof managedHandoffRuntimeEntrypoint,
): SealedRecoveryBuildConfig {
  const identityReader = fileURLToPath(
    new URL("../../src/shared/freebsd-process-identity.ts", import.meta.url),
  );
  const privateNativeLoader = fileURLToPath(
    new URL("../../src/infra/update-managed-service-handoff-native-loader.ts", import.meta.url),
  );
  return {
    entry: {
      [entry.distWorkerPath.replace(/\.mjs$/u, "")]: fileURLToPath(
        new URL(`./${entry.sourceWorkerName}.ts`, entry.currentModuleUrl),
      ),
    },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node22",
    dts: false,
    envPrefix: [],
    define: { SEALED_RUNTIME_BUILD: "true" },
    plugins: [
      createStateSchemaInlinePlugin(),
      {
        name: "openclaw:managed-handoff-native-loader",
        // All shared identity consumers in this bundle use the same private loader.
        // Normal installations and sibling sealed builds keep their own loader policy.
        resolveId(source, importer) {
          return entry === managedHandoffRuntimeEntrypoint &&
            source === "./freebsd-process-identity-native.ts" &&
            importer === identityReader
            ? privateNativeLoader
            : null;
        },
      },
    ],
    deps: { alwaysBundle: () => true, onlyBundle: false },
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: false },
    shims: true,
    sourcemap: process.env.OUTPUT_SOURCE_MAPS === "hidden" ? "hidden" : false,
  } satisfies UserConfig;
}
