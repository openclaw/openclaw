import { describe, expect, it } from "vitest";
import { parseInspectJson } from "./crabbox-worker-inspect.js";

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "cbx_012345abcdef", state: "RUNNING", ...overrides });
}

describe("Crabbox worker inspect", () => {
  it("projects lifecycle and account facts without retaining SSH transport secrets", () => {
    expect(
      parseInspectJson(
        inspectJson({
          providerMetadata: { instanceProfileAttached: false },
          ready: true,
          sshHost: "worker.example.test",
          sshPort: 2222,
          sshKey: "/tmp/provider-owned-key",
          sshUser: "desktop-user",
        }),
      ),
    ).toStrictEqual({
      id: "cbx_012345abcdef",
      state: "running",
      tailscaleEnabled: false,
      awsInstanceProfileAttached: false,
      ready: true,
      sshUser: "desktop-user",
    });
  });

  it.each([undefined, "", "   ", "<token>"])("does not invent an account from %s", (sshUser) => {
    expect(parseInspectJson(inspectJson({ sshUser })).sshUser).toBeUndefined();
  });
});
