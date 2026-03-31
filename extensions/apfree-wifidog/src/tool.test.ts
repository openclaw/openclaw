import { describe, expect, it } from "vitest";
import { createApFreeWifidogTools } from "./tool.js";

describe("apfree-wifidog intent tools", () => {
  it("kickoff tool resolves client IP from get_clients and infers gwId from a single gateway", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return {
          deviceId: "dev-1",
          connectedAtMs: Date.now(),
          lastSeenAtMs: Date.now(),
          gateway: [{ gw_id: "gw-1" }],
        };
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        if (params.op === "get_clients") {
          return {
            type: "get_clients_response",
            clients: [{ mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.1.10" }],
          };
        }
        return {
          type: "kickoff_response",
          status: "success",
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_kickoff_client",
    );
    expect(tool).toBeTruthy();

    const result = await tool?.execute?.("tool-1", {
      deviceId: "dev-1",
      clientMac: "aa-bb-cc-dd-ee-ff",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ op: "get_clients", deviceId: "dev-1" });
    expect(calls[1]).toMatchObject({
      op: "kickoff",
      deviceId: "dev-1",
      payload: {
        client_ip: "192.168.1.10",
        client_mac: "aa:bb:cc:dd:ee:ff",
        gw_id: "gw-1",
      },
    });
    expect((result as { details?: Record<string, unknown> }).details?.resolved).toEqual({
      clientIp: "192.168.1.10",
      gwId: "gw-1",
      clientMac: "aa:bb:cc:dd:ee:ff",
    });
  });

  it("get device tool accepts a device alias from the device list", async () => {
    const bridge = {
      listDevices() {
        return [{ deviceId: "dev-1", alias: "Router-1", connectedAtMs: 1, lastSeenAtMs: 1 }];
      },
      getDevice(deviceId: string) {
        if (deviceId === "Router-1" || deviceId === "dev-1") {
          return { deviceId: "dev-1", alias: "Router-1", connectedAtMs: 1, lastSeenAtMs: 1 };
        }
        return null;
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_device",
    );
    expect(tool).toBeTruthy();

    const result = await tool?.execute?.("tool-alias", {
      deviceId: "Router-1",
    });

    expect((result as { details?: Record<string, unknown> }).details?.device).toMatchObject({
      deviceId: "dev-1",
      alias: "Router-1",
    });
  });

  it("kickoff tool skips get_clients when clientIp and gwId are provided", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return {
          deviceId: "dev-1",
          connectedAtMs: Date.now(),
          lastSeenAtMs: Date.now(),
          gateway: [{ gw_id: "gw-1" }],
        };
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "kickoff_response",
          status: "success",
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_kickoff_client",
    );
    expect(tool).toBeTruthy();

    await tool?.execute?.("tool-explicit", {
      deviceId: "dev-1",
      clientMac: "aa-bb-cc-dd-ee-ff",
      clientIp: "192.168.1.20",
      gwId: "gw-explicit",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "kickoff",
      deviceId: "dev-1",
      payload: {
        client_ip: "192.168.1.20",
        client_mac: "AA:BB:CC:DD:EE:FF",
        gw_id: "gw-explicit",
      },
    });
  });

  it("trusted-domain sync tool sends the full domains array as sync_trusted_domain payload", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "sync_trusted_domain_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_sync_trusted_domains",
    );

    const result = await tool?.execute?.("tool-2", {
      deviceId: "dev-2",
      domains: ["example.com", "login.example.net"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-2",
      op: "sync_trusted_domain",
      payload: {
        domains: ["example.com", "login.example.net"],
      },
    });
    expect((result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "Synced 2 trusted domains",
    );
  });

  it("shell tool forwards command and device-side timeout to the shell op", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "shell_response", exit_code: 0, output: "ok" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_execute_shell",
    );

    await tool?.execute?.("tool-3", {
      deviceId: "dev-3",
      command: "uci show wireless",
      timeoutSeconds: 15,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-3",
      op: "shell",
      payload: {
        command: "uci show wireless",
        timeout: 15,
      },
    });
  });

  it("bpf add tool sends normalized payload to bpf_add", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_add_response", status: "success", output: "added" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_add",
    );

    const result = await tool?.execute?.("tool-4", {
      deviceId: "dev-4",
      table: "mac",
      address: "AA-BB-CC-DD-EE-FF",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-4",
      op: "bpf_add",
      payload: {
        table: "mac",
        address: "aa:bb:cc:dd:ee:ff",
      },
    });
    expect((result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "Added AA-BB-CC-DD-EE-FF",
    );
  });

  it("bpf json tool queries the selected table", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "bpf_json_response",
          data: [{ address: "203.0.113.45", bytes: 1024 }],
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_json",
    );

    const result = await tool?.execute?.("tool-5", {
      deviceId: "dev-5",
      table: "ipv4",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-5",
      op: "bpf_json",
      payload: {
        table: "ipv4",
      },
    });
    expect((result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "Fetched ipv4 BPF stats",
    );
  });

  it("bpf json tool supports sid table for active L7 traffic stats", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_json_response", data: [{ sid: 101, bps: 4096 }] };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_json",
    );

    await tool?.execute?.("tool-5b", {
      deviceId: "dev-5b",
      table: "sid",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-5b",
      op: "bpf_json",
      payload: {
        table: "sid",
      },
    });
  });

  it("bpf del tool sends normalized payload to bpf_del", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_del_response", status: "success", output: "deleted" };
      },
    };
    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_del",
    );

    await tool?.execute?.("tool-6", {
      deviceId: "dev-6",
      table: "mac",
      address: "AA-BB-CC-DD-EE-11",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-6",
      op: "bpf_del",
      payload: {
        table: "mac",
        address: "aa:bb:cc:dd:ee:11",
      },
    });
  });

  it("wireguard set tool maps payload to set_wireguard_vpn data schema", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "set_wireguard_vpn_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_set_wireguard_vpn",
    );

    await tool?.execute?.("tool-wg-set", {
      deviceId: "dev-wg",
      interface: {
        privateKey: "PRIVATE_KEY_BASE64",
        listenPort: 51820,
        addresses: ["10.0.0.1/24"],
      },
      peers: [
        {
          publicKey: "PUBLIC_KEY_BASE64",
          presharedKey: "PRESHARED_BASE64",
          allowedIps: ["0.0.0.0/0", "::/0"],
          endpointHost: "vpn.example.com",
          endpointPort: 51820,
          persistentKeepalive: 25,
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-wg",
      op: "set_wireguard_vpn",
      payload: {
        data: {
          interface: {
            private_key: "PRIVATE_KEY_BASE64",
            listen_port: 51820,
            addresses: ["10.0.0.1/24"],
          },
          peers: [
            {
              public_key: "PUBLIC_KEY_BASE64",
              preshared_key: "PRESHARED_BASE64",
              allowed_ips: ["0.0.0.0/0", "::/0"],
              endpoint_host: "vpn.example.com",
              endpoint_port: 51820,
              persistent_keepalive: 25,
            },
          ],
        },
      },
    });
  });

  it("wireguard status tool calls get_wireguard_vpn_status op", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "get_wireguard_vpn_status_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_wireguard_vpn_status",
    );

    await tool?.execute?.("tool-wg-status", {
      deviceId: "dev-wg",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-wg",
      op: "get_wireguard_vpn_status",
    });
  });

  it("generate wireguard keys tool calls generate_wireguard_keys op", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "generate_wireguard_keys_response",
          status: "success",
          data: { public_key: "test-pub-key" },
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_generate_wireguard_keys",
    );

    await tool?.execute?.("tool-genkeys", {
      deviceId: "dev-wg",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-wg",
      op: "generate_wireguard_keys",
    });
  });

  it("bpf flush tool targets the selected table", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_flush_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_flush",
    );

    await tool?.execute?.("tool-7", {
      deviceId: "dev-7",
      table: "ipv4",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-7",
      op: "bpf_flush",
      payload: {
        table: "ipv4",
      },
    });
  });

  it("bpf update tool sends target and rates to bpf_update", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_update_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_update",
    );

    await tool?.execute?.("tool-8", {
      deviceId: "dev-8",
      table: "mac",
      target: "AA-BB-CC-DD-EE-22",
      downrate: 2_000_000,
      uprate: 1_000_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-8",
      op: "bpf_update",
      payload: {
        table: "mac",
        target: "aa:bb:cc:dd:ee:22",
        downrate: 2_000_000,
        uprate: 1_000_000,
      },
    });
  });

  it("bpf update all tool sends table-wide rates to bpf_update_all", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_update_all_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_update_all",
    );

    await tool?.execute?.("tool-9", {
      deviceId: "dev-9",
      table: "ipv6",
      downrate: 1_500_000,
      uprate: 750_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-9",
      op: "bpf_update_all",
      payload: {
        table: "ipv6",
        downrate: 1_500_000,
        uprate: 750_000,
      },
    });
  });

  it("l7 active stats tool maps to bpf_json sid", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_json_response", data: [{ sid: 42, bytes: 1024 }] };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_l7_active_stats",
    );

    await tool?.execute?.("tool-10", { deviceId: "dev-10" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-10",
      op: "bpf_json",
      payload: { table: "sid" },
    });
  });

  it("l7 protocol catalog tool maps to bpf_json l7", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_json_response", data: [{ proto: "youtube" }] };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_l7_protocol_catalog",
    );

    await tool?.execute?.("tool-11", { deviceId: "dev-11" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-11",
      op: "bpf_json",
      payload: { table: "l7" },
    });
  });

  it("set wireguard vpn maps routeAllowedIps to route_allowed_ips UCI string", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "set_wireguard_vpn_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_set_wireguard_vpn",
    );

    await tool?.execute?.("tool-wg-rai", {
      deviceId: "dev-wg",
      interface: { privateKey: "abc123" },
      peers: [
        {
          publicKey: "peer-pub",
          allowedIps: ["0.0.0.0/0"],
          routeAllowedIps: false,
        },
      ],
    });

    expect(calls).toHaveLength(1);
    const data = (calls[0]?.payload as Record<string, unknown>)?.data as Record<string, unknown>;
    const peers = data?.peers as Array<Record<string, unknown>>;
    expect(peers?.[0]).toMatchObject({
      public_key: "peer-pub",
      allowed_ips: ["0.0.0.0/0"],
      route_allowed_ips: "0",
    });
    expect(peers?.[0]).not.toHaveProperty("routeAllowedIps");
  });

  it("get vpn routes tool sends get_vpn_routes op", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "get_vpn_routes_response",
          interface: "wg0",
          routes: [{ destination: "10.0.0.0/24" }],
          tunnel_up: true,
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_vpn_routes",
    );

    await tool?.execute?.("tool-vpnr-get", { deviceId: "dev-vpn" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-vpn",
      op: "get_vpn_routes",
    });
  });

  it("set vpn routes selective sends routes in data payload", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "set_vpn_routes_response",
          interface: "wg0",
          mode: "selective",
          added: 2,
          failed: 0,
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_set_vpn_routes",
    );

    await tool?.execute?.("tool-vpnr-set", {
      deviceId: "dev-vpn",
      mode: "selective",
      routes: ["1.2.3.0/24", "4.5.6.0/24"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-vpn",
      op: "set_vpn_routes",
      payload: {
        data: {
          mode: "selective",
          routes: ["1.2.3.0/24", "4.5.6.0/24"],
        },
      },
    });
  });

  it("set vpn routes full_tunnel sends exclude_ips", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "set_vpn_routes_response",
          interface: "wg0",
          mode: "full_tunnel",
          added: 3,
          failed: 0,
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_set_vpn_routes",
    );

    await tool?.execute?.("tool-vpnr-ft", {
      deviceId: "dev-vpn",
      mode: "full_tunnel",
      excludeIps: ["203.0.113.1"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-vpn",
      op: "set_vpn_routes",
      payload: {
        data: {
          mode: "full_tunnel",
          exclude_ips: ["203.0.113.1"],
        },
      },
    });
  });

  it("delete vpn routes with flushAll sends flush_all in data payload", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "delete_vpn_routes_response",
          interface: "wg0",
          flush_all: true,
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_delete_vpn_routes",
    );

    await tool?.execute?.("tool-vpnr-del", {
      deviceId: "dev-vpn",
      flushAll: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-vpn",
      op: "delete_vpn_routes",
      payload: {
        data: {
          flush_all: true,
        },
      },
    });
  });

  it("delete vpn routes with specific routes sends routes array", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "delete_vpn_routes_response",
          interface: "wg0",
          deleted: 1,
          failed: 0,
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_delete_vpn_routes",
    );

    await tool?.execute?.("tool-vpnr-del2", {
      deviceId: "dev-vpn",
      routes: ["1.2.3.0/24"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-vpn",
      op: "delete_vpn_routes",
      payload: {
        data: {
          routes: ["1.2.3.0/24"],
        },
      },
    });
  });
});
