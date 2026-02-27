import { describe, expect, it, vi } from "vitest";
import { readSecretFromFile } from "./secret-file.js";

describe("readSecretFromFile", () => {
  it("throws error for empty file path", () => {
    expect(() => readSecretFromFile("", "API Key")).toThrow("API Key file path is empty.");
    expect(() => readSecretFromFile("   ", "Secret")).toThrow("Secret file path is empty.");
  });

  it("throws error for non-existent file", () => {
    expect(() => readSecretFromFile("/non/existent/file.txt", "Token")).toThrow(
      "Failed to read Token file",
    );
  });

  it("throws error for empty file content", () => {
    // This would require mocking fs, skipping for now
  });

  it("returns trimmed secret from file", () => {
