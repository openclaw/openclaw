import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "tsdown";
import { packageActivationRuntimeEntrypoint } from "../../src/infra/package-update-activation-runtime-assets.ts";
import { managedHandoffRuntimeEntrypoint } from "../../src/infra/update-managed-service-handoff-runtime-assets.ts";
import { createStateSchemaInlinePlugin } from "./state-schema-inline-plugin.mts";

/** Each recovery entry must survive removal of the package without shared chunks. */
export function createManagedHandoffBuildConfigs() {
  return [managedHandoffRuntimeEntrypoint, packageActivationRuntimeEntrypoint].map(
    (entry) =>
      ({
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
        deps: { alwaysBundle: (id) => !isBuiltin(id), onlyBundle: false },
        outExtensions: () => ({ js: ".mjs" }),
        outputOptions: { codeSplitting: false },
        plugins: [createStateSchemaInlinePlugin()],
        shims: true,
        sourcemap: false,
      }) satisfies UserConfig,
  );
}
