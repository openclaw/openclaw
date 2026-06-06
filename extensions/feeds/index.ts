import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerFeedsCli } from "./src/cli.js";
import { registerFeedsDoctorChecks } from "./src/doctor/register.js";

export default definePluginEntry({
  id: "feeds",
  name: "Feeds",
  description: "Adds configured catalog feed source validation for skills and plugins.",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        registerFeedsCli(program);
      },
      {
        descriptors: [
          {
            name: "feeds",
            description: "Inspect configured skill and plugin catalog feeds",
            hasSubcommands: true,
          },
        ],
      },
    );
    registerFeedsDoctorChecks();
  },
});
export { registerFeedsCli } from "./src/cli.js";
export { registerFeedsDoctorChecks } from "./src/doctor/register.js";
