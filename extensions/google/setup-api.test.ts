import { describe, expect, it } from "vitest";
import setupEntry from "./setup-api.js";

describe("google setup entry", () => {
  it("registers setup runtime providers declared by the manifest", () => {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    setupEntry.register({
      registerProvider(provider) {
        providerIds.push(provider.id);
      },
      registerCliBackend(backend) {
        cliBackendIds.push(backend.id);
      },
    } as never);

    expect(providerIds).toContain("google-vertex");
    expect(cliBackendIds).toContain("google-gemini-cli");
  });
});
