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

  it("validateConfig accepts a config with a non-empty project", () => {
    const provider = createGcpSecretProvider();
    expect(() => provider.validateConfig?.({ source: "gcp", project: "p" })).not.toThrow();
  });

  it("validateConfig rejects wrong source", () => {
    const provider = createGcpSecretProvider();
    expect(() => provider.validateConfig?.({ source: "env", project: "p" })).toThrow();
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
