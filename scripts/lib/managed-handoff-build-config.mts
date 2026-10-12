import { fileURLToPath } from "node:url";
import type { UserConfig } from "tsdown";
import { packageActivationRuntimeEntrypoint } from "../../src/infra/package-update-activation-runtime-assets.ts";
import { managedHandoffRuntimeEntrypoint } from "../../src/infra/update-managed-service-handoff-runtime-assets.ts";
import { createStateSchemaInlinePlugin } from "./state-schema-inline-plugin.mts";

/** The installed CLI and invocation compiler seal the same typed lease owner. */
export function createManagedHandoffBuildConfigs() {
  return [managedHandoffRuntimeEntrypoint, packageActivationRuntimeEntrypoint].map((entry) =>
    createSealedRecoveryBuildConfig(entry),
  );
}

function createSealedRecoveryBuildConfig(entry: typeof managedHandoffRuntimeEntrypoint) {
  const identityReader = fileURLToPath(
    new URL("../../src/shared/freebsd-process-identity.ts", import.meta.url),
  );
  // Literal URLs keep both loaders visible to declaration-input capture.
  const nativeLoader = fileURLToPath(
    entry === managedHandoffRuntimeEntrypoint
      ? new URL("../../src/infra/update-managed-service-handoff-native-loader.ts", import.meta.url)
      : new URL("../../src/infra/package-update-activation-native-loader.ts", import.meta.url),
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
        // All shared identity consumers in this bundle use its recovery-owned loader.
        // Normal installations and other sealed builds keep their own loader policy.
        resolveId(source, importer) {
          return source === "./freebsd-process-identity-native.ts" && importer === identityReader
            ? nativeLoader
            : null;
        },
      },
    ],
    deps: { alwaysBundle: () => true, onlyBundle: false },
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: false },
    shims: true,
    sourcemap: false,
  } satisfies UserConfig;
}
