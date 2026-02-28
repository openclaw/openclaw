import { describe, expect, it } from "vitest";
import { readSecretFromFile } from "./secret-file.js";

describe("readSecretFromFile", () => {
  it("throws error for empty file path", () => {
    expect(() => readSecretFromFile("", "API Key")).toThrow("API Key file path is empty.");
  });
});
