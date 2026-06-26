import { Type } from "typebox";
// Type-level tests to verify schema and TypeScript types are aligned.
import { describe, expect, it } from "vitest";
import type { ImageProviderCapabilityOutput } from "./schema/image-generation.js";
import { ImageProviderCapabilityOutputSchema } from "./schema/image-generation.js";

describe("ImageProviderCapabilityOutput type alignment", () => {
  it("accepts boolean", () => {
    const value: ImageProviderCapabilityOutput = true;
    expect(value).toBe(true);
  });

  it("accepts string array", () => {
    const value: ImageProviderCapabilityOutput = ["png", "webp"];
    expect(value).toEqual(["png", "webp"]);
  });

  it("accepts empty array", () => {
    const value: ImageProviderCapabilityOutput = [];
    expect(value).toEqual([]);
  });

  it("accepts object with formats", () => {
    const value: ImageProviderCapabilityOutput = {
      formats: ["png", "jpeg"],
      qualities: ["low", "high"],
      backgrounds: ["transparent"],
    };
    expect(value).toEqual({
      formats: ["png", "jpeg"],
      qualities: ["low", "high"],
      backgrounds: ["transparent"],
    });
  });

  it("schema has three union branches", () => {
    const schema = ImageProviderCapabilityOutputSchema;
    expect(schema.anyOf).toBeDefined();
    expect(schema.anyOf?.length).toBe(3);
    expect(schema.anyOf?.[0]).toEqual(Type.Boolean());
    expect(schema.anyOf?.[1]).toEqual(Type.Array(Type.String()));
    expect(schema.anyOf?.[2]?.type).toBe("object");
  });
});
