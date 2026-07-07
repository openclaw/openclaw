import { describe, expect, it } from "vitest";
import { resolvePodmanPluginConfig } from "./config.js";

describe("resolvePodmanPluginConfig", () => {
  it("defaults to the podman command", () => {
    expect(resolvePodmanPluginConfig(undefined)).toEqual({ command: "podman" });
  });

  it("trims command and optional remote selectors", () => {
    expect(
      resolvePodmanPluginConfig({
        command: " /usr/bin/podman ",
        connection: " dev ",
      }),
    ).toEqual({
      command: "/usr/bin/podman",
      connection: "dev",
    });
  });

  it("rejects connection and url together", () => {
    expect(() =>
      resolvePodmanPluginConfig({
        connection: "dev",
        url: "unix:///run/user/1000/podman/podman.sock",
      }),
    ).toThrow(/cannot set both connection and url/i);
  });
});
