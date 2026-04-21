import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";

export default defineSingleProviderPluginEntry({
  providerId: "agnes-ai",

  catalog: {
    models: [
      {
        id: "agnes-1.5-pro",
        name: "Agnes 1.5 Pro",
        type: "text"
      }
    ]
  },

  auth: [
    {
      id: "apiKey",
      label: "API Key",
      envVars: ["AGNES_API_KEY"]
    }
  ]
});
