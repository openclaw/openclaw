import { describe, expect, it } from "vitest";
import {
  createAppleContainerCommandMissingError,
  createAppleContainerSystemStoppedError,
  createAppleContainerUnsupportedHostError,
} from "./cli.js";

describe("apple-container cli errors", () => {
  it("formats the missing command error", () => {
    expect(createAppleContainerCommandMissingError("container").message).toContain(
      "requires the Apple container CLI",
    );
  });

  it("formats the unsupported host error", () => {
    expect(createAppleContainerUnsupportedHostError().message).toContain(
      "macOS Apple silicon hosts",
    );
  });

  it("formats the stopped system error", () => {
    expect(createAppleContainerSystemStoppedError("container").message).toContain(
      "system status --format json",
    );
  });
});
