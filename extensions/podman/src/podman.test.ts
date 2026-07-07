import { describe, expect, it } from "vitest";
import { buildPodmanInvocation } from "./podman.js";

describe("buildPodmanInvocation", () => {
  it("uses the configured command and appends args", () => {
    expect(
      buildPodmanInvocation({
        config: { command: "/opt/bin/podman" },
        args: ["inspect", "openclaw-sbx-main"],
      }),
    ).toEqual({
      command: "/opt/bin/podman",
      args: ["inspect", "openclaw-sbx-main"],
    });
  });

  it("places remote options before the subcommand", () => {
    expect(
      buildPodmanInvocation({
        config: { command: "podman", url: "unix:///run/user/1000/podman/podman.sock" },
        args: ["exec", "sandbox", "true"],
      }).args,
    ).toEqual(["--url", "unix:///run/user/1000/podman/podman.sock", "exec", "sandbox", "true"]);
  });
});
