import type { MullusiPluginApi } from "mullusi/plugin-sdk/core";

export function registerMatrixCliMetadata(api: MullusiPluginApi) {
  api.registerCli(
    async ({ program }) => {
      const { registerMatrixCli } = await import("./cli.js");
      registerMatrixCli({ program });
    },
    {
      descriptors: [
        {
          name: "matrix",
          description: "Manage Matrix accounts, verification, devices, and profile state",
          hasSubcommands: true,
        },
      ],
    },
  );
}
