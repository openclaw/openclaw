import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
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
    const store = createBeamStore(api.runtime);
    api.registerSessionCatalog(createBeamSessionCatalog(store));
    for (const operation of ["list", "read"] as const) {
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
