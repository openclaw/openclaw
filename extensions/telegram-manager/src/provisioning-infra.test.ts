import { describe, expect, it } from "vitest";
import { createHetznerClient } from "./hetzner-client.js";
import {
  buildGatewayHealthUrl,
  buildOpenClawUserData,
  isGatewayHealthyStatus,
} from "./openclaw-installer.js";

describe("hetzner client", () => {
  it("creates a server with user_data + labels", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const client = createHetznerClient({
      token: "t",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen = { url, body: JSON.parse(String(init?.body)) };
        return new Response(
          JSON.stringify({
            server: {
              id: 7,
              name: "openclaw-1",
              status: "starting",
              public_net: { ipv4: { ip: "1.2.3.4" } },
            },
          }),
          { status: 201 },
        );
      }) as never,
    });
    const server = await client.createServer({
      name: "openclaw-1",
      serverType: "cx23",
      location: "nbg1",
      image: "debian-12",
      sshKeys: ["k"],
      userData: "#cloud-config",
    });
    expect(server).toMatchObject({ id: 7, publicIpv4: "1.2.3.4" });
    expect(seen?.url).toBe("https://api.hetzner.cloud/v1/servers");
    expect(seen?.body).toMatchObject({ server_type: "cx23", user_data: "#cloud-config" });
  });

  it("surfaces API errors", async () => {
    const client = createHetznerClient({
      token: "t",
      fetchImpl: (async () => new Response("unprocessable", { status: 422 })) as never,
    });
    await expect(
      client.createServer({
        name: "x",
        serverType: "cx23",
        location: "nbg1",
        image: "debian-12",
        sshKeys: [],
        userData: "u",
      }),
    ).rejects.toThrow("422");
  });
});

describe("openclaw installer", () => {
  it("builds cloud-init with tokens, firewall, tunnel guidance", () => {
    const userData = buildOpenClawUserData({
      botToken: "1:A",
      gatewayToken: "gw",
      telegramAllowFrom: ["123"],
    });
    expect(userData.startsWith("#cloud-config")).toBe(true);
    expect(userData).toContain("TELEGRAM_BOT_TOKEN=1:A");
    expect(userData).toContain("OPENCLAW_GATEWAY_TOKEN=gw");
    expect(userData).toContain("get.docker.com");
    expect(userData).toContain("AllowTcpForwarding local");
  });

  it("classifies gateway health", () => {
    expect(isGatewayHealthyStatus(200)).toBe(true);
    expect(isGatewayHealthyStatus(500)).toBe(false);
    expect(buildGatewayHealthUrl("1.2.3.4")).toBe("http://1.2.3.4:18789/health");
  });
});
