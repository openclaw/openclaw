import { describe, expect, it } from "vitest";
import { resolveAccount } from "./accounts.js";

describe("resolveAccount", () => {
  it("defaults strictBinding to true", () => {
    const account = resolveAccount({ channels: { naverworks: {} } }, "default");
    expect(account.strictBinding).toBe(true);
  });

  it("allows strictBinding override per account", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            strictBinding: true,
            accounts: {
              default: {
                strictBinding: false,
              },
            },
          },
        },
      },
      "default",
    );

    expect(account.strictBinding).toBe(false);
  });

  it("resolves outbound credentials with account override", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            botId: "top-bot",
            accessToken: "top-token",
            accounts: {
              default: {
                botId: "acc-bot",
                accessToken: "acc-token",
              },
            },
          },
        },
      },
      "default",
    );

    expect(account.botId).toBe("acc-bot");
    expect(account.accessToken).toBe("acc-token");
    expect(account.apiBaseUrl).toBe("https://www.worksapis.com/v1.0");
    expect(account.tokenUrl).toBe("https://auth.worksmobile.com/oauth2/v2.0/token");
  });

  it("supports JWT auth settings", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            clientId: "client-id",
            clientSecret: "client-secret",
            serviceAccount: "serviceaccount@example.com",
            privateKey: "line1\\nline2",
            scope: "bot user.read",
            jwtIssuer: "issuer-id",
          },
        },
      },
      "default",
    );

    expect(account.clientId).toBe("client-id");
    expect(account.clientSecret).toBe("client-secret");
    expect(account.serviceAccount).toBe("serviceaccount@example.com");
    expect(account.privateKey).toBe("line1\nline2");
    expect(account.scope).toBe("bot user.read");
    expect(account.jwtIssuer).toBe("issuer-id");
  });
  it("resolves botSecret from account-level config", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            botSecret: "top-secret",
            accounts: {
              default: {
                botSecret: "acc-secret",
              },
            },
          },
        },
      },
      "default",
    );

    expect(account.botSecret).toBe("acc-secret");
  });

  it("defaults markdown rendering mode/theme", () => {
    const account = resolveAccount({ channels: { naverworks: {} } }, "default");
    expect(account.markdownMode).toBe("auto-flex");
    expect(account.markdownTheme).toBe("auto");
  });

  it("allows markdown theme override per account", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            markdownTheme: "light",
            accounts: {
              default: {
                markdownTheme: "dark",
              },
            },
          },
        },
      },
      "default",
    );

    expect(account.markdownTheme).toBe("dark");
  });

  it("allows markdownMode override per account", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            markdownMode: "plain",
            accounts: {
              default: {
                markdownMode: "auto-flex",
              },
            },
          },
        },
      },
      "default",
    );

    expect(account.markdownMode).toBe("auto-flex");
  });

  it("merges statusStickers with account override", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            statusStickers: {
              enabled: true,
              received: { packageId: "1", stickerId: "1" },
              failed: { packageId: "1", stickerId: "3" },
            },
            accounts: {
              default: {
                statusStickers: {
                  processing: { packageId: "1", stickerId: "2" },
                },
              },
            },
          },
        },
      },
      "default",
    );

    expect(account.statusStickers?.enabled).toBe(true);
    expect(account.statusStickers?.received).toEqual({ packageId: "1", stickerId: "1" });
    expect(account.statusStickers?.processing).toEqual({ packageId: "1", stickerId: "2" });
    expect(account.statusStickers?.failed).toEqual({ packageId: "1", stickerId: "3" });
  });

  it("applies contextual default status stickers when enabled without explicit refs", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            statusStickers: {
              enabled: true,
            },
          },
        },
      },
      "default",
    );

    expect(account.statusStickers?.received).toEqual({ packageId: "789", stickerId: "10855" });
    expect(account.statusStickers?.processing).toEqual({
      packageId: "534",
      stickerId: "2429",
    });
    expect(account.statusStickers?.failed).toEqual({ packageId: "1", stickerId: "3" });
  });

  it("enables status stickers by default", () => {
    const account = resolveAccount({ channels: { naverworks: {} } }, "default");

    expect(account.statusStickers?.enabled).toBe(true);
    expect(account.statusStickers?.received).toEqual({ packageId: "789", stickerId: "10855" });
    expect(account.statusStickers?.processing).toEqual({
      packageId: "534",
      stickerId: "2429",
    });
    expect(account.statusStickers?.failed).toEqual({ packageId: "1", stickerId: "3" });
  });
});
