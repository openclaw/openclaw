import { describe, expect, it } from "vitest";
import { buildUserSandboxArgv } from "./user.js";

describe("user sandbox helpers", () => {
  it("builds su argv without shell-splitting username or command", () => {
    expect(
      buildUserSandboxArgv({
        settings: {
          command: "su",
          username: "sandbox",
        },
        remoteCommand: "printf hi",
      }),
    ).toEqual(["su", "sandbox", "-c", "printf hi"]);
  });
});
