import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "secrets-gcp",
  name: "GCP Secret Manager",
  description: 'Resolve SecretRef sources of type "gcp" via Google Cloud Secret Manager.',
  register() {
    // Runtime is exposed through secret-provider.ts so the secrets resolver can
    // load only the narrow factory artifact instead of the full plugin entrypoint.
  },
});
