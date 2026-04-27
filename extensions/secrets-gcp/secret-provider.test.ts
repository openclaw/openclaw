import { describe, expect, it, vi } from "vitest";
import { createGcpSecretProvider } from "./secret-provider.js";

describe("secrets-gcp createGcpSecretProvider", () => {
  it("declares id 'gcp' and a label", () => {
    const provider = createGcpSecretProvider();
    expect(provider.id).toBe("gcp");
    expect(provider.label.length).toBeGreaterThan(0);
  });

  it("validateConfig rejects configs missing project", () => {
    const provider = createGcpSecretProvider();
    expect(() => provider.validateConfig?.({ source: "gcp" })).toThrow(/project/);
    expect(() => provider.validateConfig?.({ source: "gcp", project: "" })).toThrow(/project/);
    expect(() => provider.validateConfig?.({ source: "gcp", project: "  " })).toThrow(/project/);
  });

  it("validateConfig rejects projects that do not match the GCP grammar", () => {
    const provider = createGcpSecretProvider();
    // Too short (< 6 chars)
    expect(() => provider.validateConfig?.({ source: "gcp", project: "p" })).toThrow(/grammar/);
    // Starts with digit
    expect(() => provider.validateConfig?.({ source: "gcp", project: "1abcdef" })).toThrow(
      /grammar/,
    );
    // Contains uppercase
    expect(() => provider.validateConfig?.({ source: "gcp", project: "MyProject1" })).toThrow(
      /grammar/,
    );
    // Path-traversal attempt
    expect(() => provider.validateConfig?.({ source: "gcp", project: "../foo" })).toThrow(
      /grammar/,
    );
    // Trailing dash (must end with letter or digit)
    expect(() => provider.validateConfig?.({ source: "gcp", project: "myproject-" })).toThrow(
      /grammar/,
    );
  });

  it("validateConfig accepts a project matching the GCP grammar", () => {
    const provider = createGcpSecretProvider();
    expect(() =>
      provider.validateConfig?.({ source: "gcp", project: "my-project-1" }),
    ).not.toThrow();
    expect(() =>
      provider.validateConfig?.({ source: "gcp", project: "myorg-prod-01" }),
    ).not.toThrow();
  });

  it("validateConfig rejects malformed versionSuffix", () => {
    const provider = createGcpSecretProvider();
    expect(() =>
      provider.validateConfig?.({ source: "gcp", project: "my-project", versionSuffix: "bogus" }),
    ).toThrow(/versionSuffix/);
    expect(() =>
      provider.validateConfig?.({ source: "gcp", project: "my-project", versionSuffix: "0" }),
    ).toThrow(/versionSuffix/);
    expect(() =>
      provider.validateConfig?.({ source: "gcp", project: "my-project", versionSuffix: "-1" }),
    ).toThrow(/versionSuffix/);
  });

  it("validateConfig accepts versionSuffix 'latest' or a positive integer", () => {
    const provider = createGcpSecretProvider();
    expect(() =>
      provider.validateConfig?.({
        source: "gcp",
        project: "my-project",
        versionSuffix: "latest",
      }),
    ).not.toThrow();
    expect(() =>
      provider.validateConfig?.({ source: "gcp", project: "my-project", versionSuffix: "3" }),
    ).not.toThrow();
  });

  it("validateConfig rejects wrong source", () => {
    const provider = createGcpSecretProvider();
    expect(() => provider.validateConfig?.({ source: "env", project: "my-project" })).toThrow(
      /config.source must be/,
    );
  });

  it("resolve() accepts hyphenated GCP secret names (per GCP grammar)", async () => {
    vi.resetModules();
    let receivedName = "";
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: class {
        async accessSecretVersion({ name }: { name: string }) {
          receivedName = name;
          return [{ payload: { data: "ok" } }];
        }
      },
    }));
    const { createGcpSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    const out = await provider.resolve({
      refs: [{ source: "gcp", provider: "myGcp", id: "openclaw-gateway-token" }],
      providerName: "myGcp",
      providerConfig: { source: "gcp", project: "my-project" },
      env: process.env,
    });
    expect(receivedName).toBe("projects/my-project/secrets/openclaw-gateway-token/versions/latest");
    expect(out.get("openclaw-gateway-token")).toBe("ok");
  });

  it("resolve() rejects ref ids with disallowed characters before spawning client", async () => {
    vi.resetModules();
    let clientCreated = false;
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: class {
        constructor() {
          clientCreated = true;
        }
        async accessSecretVersion() {
          throw new Error("should not be reached");
        }
      },
    }));
    const { createGcpSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await expect(
      provider.resolve({
        refs: [{ source: "gcp", provider: "myGcp", id: "../escape" }],
        providerName: "myGcp",
        providerConfig: { source: "gcp", project: "my-project" },
        env: process.env,
      }),
    ).rejects.toThrow(/ref id .*must match/);
    expect(clientCreated).toBe(false);
  });

  it("resolves a ref via the GCP SDK with default 'latest' version", async () => {
    vi.resetModules();
    let receivedName = "";
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: class {
        async accessSecretVersion({ name }: { name: string }) {
          receivedName = name;
          return [{ payload: { data: Buffer.from("the-value", "utf-8") } }];
        }
      },
    }));
    const { createGcpSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    const out = await provider.resolve({
      refs: [{ source: "gcp", provider: "myGcp", id: "MY_KEY" }],
      providerName: "myGcp",
      providerConfig: { source: "gcp", project: "test-proj" },
      env: process.env,
    });
    expect(receivedName).toBe("projects/test-proj/secrets/MY_KEY/versions/latest");
    expect(out.get("MY_KEY")).toBe("the-value");
  });

  it("uses versionSuffix when provided", async () => {
    vi.resetModules();
    let receivedName = "";
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: class {
        async accessSecretVersion({ name }: { name: string }) {
          receivedName = name;
          return [{ payload: { data: "raw-string" } }];
        }
      },
    }));
    const { createGcpSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    const out = await provider.resolve({
      refs: [{ source: "gcp", provider: "myGcp", id: "K" }],
      providerName: "myGcp",
      providerConfig: { source: "gcp", project: "p", versionSuffix: "3" },
      env: process.env,
    });
    expect(receivedName).toBe("projects/p/secrets/K/versions/3");
    expect(out.get("K")).toBe("raw-string");
  });

  it("throws on missing payload data", async () => {
    vi.resetModules();
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: class {
        async accessSecretVersion() {
          return [{ payload: {} }];
        }
      },
    }));
    const { createGcpSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await expect(
      provider.resolve({
        refs: [{ source: "gcp", provider: "myGcp", id: "K" }],
        providerName: "myGcp",
        providerConfig: { source: "gcp", project: "p" },
        env: process.env,
      }),
    ).rejects.toThrow(/no payload data/);
  });
});
