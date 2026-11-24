import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createBeamExecutableResolver } from "./src/executable.js";
import { createBeamRequestHandler } from "./src/http.js";
import { createBeamMirrorService } from "./src/mirror.js";
import { createBeamOwnedViewHandler } from "./src/owned-view.js";
import { createBeamSessionCatalog } from "./src/session-catalog.js";
import { createBeamStore } from "./src/store.js";

export default definePluginEntry({
  id: "beam",
  name: "Beam",
  description: "Receive redacted coding-session snapshots for review or Team continuation",
  register(api) {
    const resolveExecutable = createBeamExecutableResolver(api.rootDir ?? path.dirname(api.source));
    api.registerCli(
      ({ program }) => {
        const beam = program.command("beam").description(manifest.cliCommands[0]!.description);
        beam
          .command("doctor")
          .description("Check the installed native Beam cleaner for outbound mirroring")
          .option("--json", "Print machine-readable cleaner status")
          .action(async (options: { json?: boolean }) => {
            const { runBeamDoctor } = await import("./src/doctor.js");
            await runBeamDoctor(options, resolveExecutable);
          });
      },
      { descriptors: manifest.cliCommands },
    );
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    const store = createBeamStore(api.runtime);
    api.registerSessionCatalog(createBeamSessionCatalog(store));
    for (const operation of ["list", "read", "resolve", "continue"] as const) {
      api.registerGatewayMethod(
        `beam.owned.${operation}`,
        createBeamOwnedViewHandler(store, operation),
        {
          scope: "operator.sessions.write",
          profileAccess: "required",
        },
      );
    }
    api.registerService(store.catalogService);
    api.registerHttpRoute({
      path: "/api/v1/beam/sessions",
      auth: "gateway",
      match: "exact",
      handler: createBeamRequestHandler({
        store,
        resolveControlUiBasePath: () => api.runtime.config.current().gateway?.controlUi?.basePath,
      }),
    });
    api.registerService(createBeamMirrorService({ runtime: api.runtime }));
  },
});
