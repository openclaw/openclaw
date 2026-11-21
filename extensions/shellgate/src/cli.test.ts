import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it } from "vitest";
import plugin from "../index.js";

it("declares machine output before lazy CLI registration can emit diagnostics", () => {
  let machineOutput = false;
  plugin.register(
    createTestPluginApi({
      registrationMode: "cli-metadata",
      registerCli(_registrar, options) {
        const descriptor = options?.descriptors?.[0];
        machineOutput =
          descriptor && "machineOutput" in descriptor
            ? descriptor.machineOutput?.({
                argv: ["node", "openclaw", "shellgate", "caddy"],
                stdoutIsTTY: false,
              }) === true
            : false;
      },
    }),
  );
  expect(machineOutput).toBe(true);
});
