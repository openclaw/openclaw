import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { formatSnowflakeApiKey, prepareSnowflakeRuntimeAuth } from "./runtime-auth.js";

const loadOAuth = createLazyRuntimeModule(() => import("./oauth.js"));

export default definePluginEntry({
  id: "snowflake",
  name: "Snowflake Cortex",
  description: "Snowflake Cortex inference with local application OAuth",
  register(api) {
    api.registerProvider({
      id: "snowflake",
      label: "Snowflake Cortex",
      docsPath: "/providers/snowflake",
      auth: [
        {
          id: "oauth",
          label: "Snowflake local browser sign-in",
          kind: "oauth",
          wizard: {
            choiceId: "snowflake-oauth",
            choiceLabel: "Snowflake local browser sign-in",
            groupId: "snowflake",
            groupLabel: "Snowflake Cortex",
          },
          run: async (ctx) => (await loadOAuth()).loginSnowflake(ctx),
        },
      ],
      refreshOAuth: async (credential) => (await loadOAuth()).refreshSnowflake(credential),
      formatApiKey: formatSnowflakeApiKey,
      prepareRuntimeAuth: prepareSnowflakeRuntimeAuth,
    });
  },
});
