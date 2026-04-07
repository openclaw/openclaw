import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyDatabricksConfig, DATABRICKS_DEFAULT_MODEL_REF } from "./api.js";
import { buildDatabricksProvider } from "./provider-catalog.js";

const PROVIDER_ID = "databricks";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Databricks Provider",
  description: "Bundled Databricks Serving provider plugin",
  provider: {
    label: "Databricks",
    docsPath: "/providers/databricks",
    auth: [
      {
        methodId: "api-key",
        label: "Databricks API key",
        hint: "API key or token",
        optionKey: "databricksApiKey",
        flagName: "--databricks-api-key",
        envVar: "DATABRICKS_API_KEY",
        promptMessage: "Enter Databricks API key",
        defaultModel: DATABRICKS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDatabricksConfig(cfg),
        wizard: {
          groupLabel: "Databricks",
        },
      },
    ],
    catalog: {
      buildProvider: buildDatabricksProvider,
    },
  },
  register(_api) {
  },
});
