import path from "node:path";
import type { ControlUiMockGatewayScenario } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { hash } from "./report.ts";

export function fingerprintFixtures(
  scenarios: readonly ControlUiMockGatewayScenario[],
  repository: string,
): string {
  return hash(
    JSON.stringify(
      scenarios.map((scenario) => ({
        ...scenario,
        // Native plugin code is the UI under test; only its checkout location varies.
        nativePlugins: scenario.nativePlugins?.map((plugin) => ({
          ...plugin,
          rootDir: path.relative(repository, plugin.rootDir).split(path.sep).join("/"),
        })),
      })),
    ),
  );
}
