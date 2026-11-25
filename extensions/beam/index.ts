import path from "node:path";
import { getGatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createBeamContinuation } from "./src/continuation-v2.js";
import { createBeamExecutableResolver } from "./src/executable.js";
import { createBeamV2Handler } from "./src/http-v2.js";
import { createBeamIngressLimits, createBeamRequestHandler } from "./src/http.js";
import { registerBeamMirror } from "./src/mirror-service.js";
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
    const limits = createBeamIngressLimits();
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
        limits,
        store,
        resolveControlUiBasePath: () => api.runtime.config.current().gateway?.controlUi?.basePath,
      }),
    });
    api.registerHttpRoute({
      path: "/api/v2/beam",
      auth: "gateway",
      match: "prefix",
      handler: createBeamV2Handler({
        limits,
        readPublication: store.readPublication,
        getScreenshot: store.getScreenshot,
        putSnapshot: store.putSnapshot,
        releasePublication: store.releasePublication,
        continuation: createBeamContinuation(api.runtime, store),
        currentAuthority: getGatewayRequestAuthorityV1,
        controlUiBasePath: () => api.runtime.config.current().gateway?.controlUi?.basePath,
      }),
    });
    registerBeamMirror(api, resolveExecutable);
  },
});
