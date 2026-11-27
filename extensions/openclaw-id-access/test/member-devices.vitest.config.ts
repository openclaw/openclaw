// Local visual proof can borrow an existing shell while building the plugin from source.
// Run with OPENCLAW_MEMBER_DEVICES_UI_ROOT pointing at a built Control UI directory.
import { defineConfig } from "vitest/config";
import { createUiE2eVitestConfig } from "../../../test/vitest/vitest.ui-e2e.config.ts";

const base = createUiE2eVitestConfig();
const projects = await Promise.all(
  (base.test?.projects ?? []).map((project) => Promise.resolve(project)),
);
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: projects.map((project) => {
      if (typeof project !== "object" || !project.test) {
        throw new Error("Expected an inline UI E2E project");
      }
      return Object.assign(project, {
        test: {
          ...project.test,
          globalSetup: ["test/vitest/vitest.ui-e2e.global-setup.ts"],
          setupFiles: [],
        },
      });
    }),
  },
});
