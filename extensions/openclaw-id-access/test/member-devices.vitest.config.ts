// Local visual proof can borrow an existing shell while building the plugin from source.
// Run with OPENCLAW_MEMBER_DEVICES_UI_ROOT pointing at a built Control UI directory.
import { defineConfig } from "vitest/config";
import { createUiE2eVitestConfig } from "../../../test/vitest/vitest.ui-e2e.config.ts";

const base = createUiE2eVitestConfig();
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: base.test?.projects?.map((project) => {
      if (typeof project !== "object" || !project.test) {
        throw new Error("Expected an inline UI E2E project");
      }
      return {
        ...project,
        test: {
          ...project.test,
          globalSetup: ["test/vitest/vitest.ui-e2e.global-setup.ts"],
          setupFiles: [],
        },
      };
    }),
  },
});
