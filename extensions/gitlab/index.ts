import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGitLabRepositorySource } from "./src/source.js";
import { resolveGitLabOrigin } from "./src/url.js";

export default definePluginEntry({
  id: "gitlab",
  name: "GitLab",
  description: "Start sessions from public GitLab repositories.",
  register(api) {
    const origin = resolveGitLabOrigin(api.pluginConfig?.baseUrl);
    api.registerRepositorySource(createGitLabRepositorySource(origin));
    api.registerGatewayMethod(
      "gitlab.repositories.search",
      async ({ params, respond }) => {
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (query.length < 2 || query.length > 200) {
          respond(true, { credential: "configured", projects: [] });
          return;
        }
        const { searchGitLabProjects } = await import("./src/search.js");
        try {
          respond(true, await searchGitLabProjects({ origin, query }));
        } catch (error) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              error instanceof Error ? error.message : "GitLab search failed.",
            ),
          );
        }
      },
      // Public project data does not depend on the caller's user profile.
      { scope: "operator.read", profileAccess: "independent" },
    );
  },
});
