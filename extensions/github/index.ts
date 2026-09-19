import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { GITHUB_COMMIT_PATH_PATTERN, GITHUB_ITEM_PATH_PATTERN } from "./src/targets.js";

export default definePluginEntry({
  id: "github",
  name: "GitHub",
  description: "Public GitHub link previews and document reader",
  register(api) {
    // Commits open in the reader, but do not spend anonymous quota on hover.
    for (const reader of [
      { id: "github", pathPattern: GITHUB_ITEM_PATH_PATTERN, previewMethod: "github.preview" },
      { id: "github-commit", pathPattern: GITHUB_COMMIT_PATH_PATTERN },
    ]) {
      api.session.controls.registerControlUiDescriptor({
        surface: "link-reader",
        id: reader.id,
        label: "GitHub",
        icon: "github",
        linkReader: {
          hosts: ["github.com"],
          pathPattern: reader.pathPattern,
          detailMethod: "github.detail",
          ...(reader.previewMethod ? { previewMethod: reader.previewMethod } : {}),
        },
        requiredScopes: ["operator.read"],
      });
    }
    // Metadata registration stays cheap. Disabling the plugin removes both the
    // descriptors and methods; HTTP readers load only on their first request.
    // The shipped controlUi.githubPreview host adapter retains managed identity
    // selection and calls this plugin's public data API; it is not re-registered.
    for (const method of ["github.preview", "github.detail"] as const) {
      api.registerGatewayMethod(
        method,
        async (options) => {
          const { githubHandlers } = await import("./src/handlers.js");
          await githubHandlers[method](options);
        },
        // Public GitHub data does not depend on the caller's user profile.
        // Gateway connect/role/operator.read checks still own admission.
        { scope: "operator.read", profileAccess: "independent" },
      );
    }
  },
});
