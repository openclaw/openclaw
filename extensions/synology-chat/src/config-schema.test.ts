import { describe, expect, it } from "vitest";
import { SynologyChatChannelConfigSchema } from "./config-schema.js";

describe("SynologyChatChannelConfigSchema", () => {
  it("exports dangerouslyAllowNameMatching in the JSON schema", () => {
    const properties = (SynologyChatChannelConfigSchema.schema.properties ?? {}) as Record<
      string,
      { type?: string }
    >;

    expect(properties.dangerouslyAllowNameMatching?.type).toBe("boolean");
  });

  it("keeps the schema open for plugin-specific passthrough fields", () => {
    const additionalProperties = SynologyChatChannelConfigSchema.schema.additionalProperties;
    expect(additionalProperties === true || JSON.stringify(additionalProperties) === "{}").toBe(
      true,
    );
  });
});
