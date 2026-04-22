import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { listMemoryCorePublicArtifacts } from "./src/public-artifacts.js";

export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api) {
    // Register public artifacts provider so that wiki bridge import can
    // discover memory artifacts when running from the CLI process.
    api.registerMemoryCapability({
      publicArtifacts: {
        listArtifacts: listMemoryCorePublicArtifacts,
      },
    });

    api.registerCli(
      async ({ program }) => {
        const { registerMemoryCli } = await import("./src/cli.js");
        registerMemoryCli(program);
      },
      {
        descriptors: [
          {
            name: "memory",
            description: "Search, inspect, and reindex memory files",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
