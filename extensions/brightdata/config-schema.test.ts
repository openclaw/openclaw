import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfigSchema, lookupConfigSchema } from "../../src/config/schema.js";

type BrightDataManifest = {
  uiHints?: Record<
    string,
    {
      label?: string;
      help?: string;
      tags?: string[];
      advanced?: boolean;
      sensitive?: boolean;
      placeholder?: string;
    }
  >;
  configSchema?: Record<string, unknown>;
};

function readBrightDataManifest(): BrightDataManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as BrightDataManifest;
}

describe("brightdata manifest schema surfaces", () => {
  it("exposes the full shared webSearch config surface", () => {
    const manifest = readBrightDataManifest();
    const configSchema = manifest.configSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    const webSearch = configSchema?.properties?.webSearch as
      | { properties?: Record<string, unknown> }
      | undefined;
    const properties = webSearch?.properties ?? {};

    expect(properties.apiKey).toBeTruthy();
    expect(properties.baseUrl).toMatchObject({ type: "string" });
    expect(properties.unlockerZone).toMatchObject({ type: "string" });
    expect(properties.browserZone).toMatchObject({ type: "string" });
    expect(properties.timeoutSeconds).toMatchObject({ type: "integer", minimum: 1 });
    expect(properties.pollingTimeoutSeconds).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("supports config schema lookup for browser zone paths", () => {
    const manifest = readBrightDataManifest();
    const schema = buildConfigSchema({
      plugins: [
        {
          id: "brightdata",
          name: "Bright Data",
          configSchema: manifest.configSchema,
          configUiHints: manifest.uiHints,
        },
      ],
    });

    const lookup = lookupConfigSchema(
      schema,
      "plugins.entries.brightdata.config.webSearch.browserZone",
    );
    expect(lookup?.path).toBe("plugins.entries.brightdata.config.webSearch.browserZone");
    expect(lookup?.hint?.label).toBe("Bright Data Browser Zone");
    expect(lookup?.schema).toMatchObject({ type: "string" });
  });
});
