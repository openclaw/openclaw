import fs from "node:fs";
import path from "node:path";

const root = process.env.FIXTURE_PACKAGE_DIR;
const version = process.env.FIXTURE_PACKAGE_VERSION;
if (!version) {
  throw new Error("missing fixture package version");
}
fs.mkdirSync(root, { recursive: true });
for (const [file, value] of [
  [
    "package.json",
    {
      name: "@openclaw/brave-plugin",
      version,
      openclaw: { extensions: ["./index.js"] },
    },
  ],
  [
    "openclaw.plugin.json",
    {
      id: "brave",
      activation: { onStartup: false },
      setup: { providers: [{ id: "brave", envVars: ["BRAVE_API_KEY"] }] },
      contracts: { webSearchProviders: ["brave"] },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          webSearch: {
            type: "object",
            additionalProperties: false,
            properties: {
              apiKey: { type: ["string", "object"] },
              mode: { type: "string", enum: ["web", "llm-context"] },
              baseUrl: { type: ["string", "object"] },
            },
          },
        },
      },
    },
  ],
]) {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}
fs.writeFileSync(
  path.join(root, "index.js"),
  `module.exports = { id: "brave", name: "Brave Fixture", register() {} };\n`,
);
