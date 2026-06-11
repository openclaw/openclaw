import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerBookWriterCli } from "./src/cli.js";
import { resolveBookWriterConfig } from "./src/config.js";
import { registerBookWriterGatewayMethods } from "./src/gateway.js";

export default definePluginEntry({
  id: "book-writer",
  name: "Book Writer",
  description: "Creates original review-ready book packages with local-first model governance.",
  register(api: OpenClawPluginApi) {
    const config = resolveBookWriterConfig(api.pluginConfig, api.config);
    registerBookWriterGatewayMethods({ api, config });
    api.registerCli(
      ({ program }) => {
        registerBookWriterCli(program, config, api.config);
      },
      {
        descriptors: [
          {
            name: "books",
            description: "Create original review-ready book packages",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
