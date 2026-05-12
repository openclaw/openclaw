import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "secrets-keyring",
  name: "OS Keyring",
  description: 'Resolve SecretRef sources of type "keyring" via the OS-native credential store.',
  register() {
    // Runtime is exposed through secret-provider.ts so the secrets resolver can
    // load only the narrow factory artifact instead of the full plugin entrypoint.
  },
});
