import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderPortalPageHtml } from "./portal-page-renderer.js";
import { createClawWRTTools } from "./tool.js";

const { execSyncMock, execFileSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn((command: string) => {
    if (command.startsWith("which nwct-server")) {
      return "/usr/bin/nwct-server\n";
    }
    if (command.startsWith("sudo cat /etc/nwct/nwct-server.toml")) {
      return 'bindPort = 7000\nauth.token = "secret-token"\n';
    }
    if (command.startsWith("systemctl is-active nwct-server")) {
      return "active\n";
    }
    if (command.startsWith("sudo ss -tulpn | grep nwct-server")) {
      return 'tcp LISTEN 0 4096 0.0.0.0:7000 0.0.0.0:* users:(("nwct-server",pid=1234,fd=3))\n';
    }
    return "";
  }),
  execFileSyncMock: vi.fn((file: string, args: string[] = []) => {
    if (file === "sudo" && args[0] === "wg-quick" && args[1] === "strip") {
      return "[Interface]\nAddress = 10.0.0.1/24\n";
    }
    return "";
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: execSyncMock,
    execFileSync: execFileSyncMock,
  };
});

describe("openclaw-wrt intent tools", () => {
  it("router discovery and detail tools mention online and wireless router wording", () => {
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
    };

    const tools = createClawWRTTools({ bridge: bridge as never });
    const listTool = tools.find((entry) => entry.name === "clawwrt_list_devices");
    const getDeviceTool = tools.find((entry) => entry.name === "clawwrt_get_device");
    const getStatusTool = tools.find((entry) => entry.name === "clawwrt_get_status");

    expect(listTool?.description).toContain("online routers");
    expect(listTool?.description).toContain("wireless routers");
    expect(getDeviceTool?.description).toContain("connection snapshot");
    expect(getDeviceTool?.description).toContain("not the full runtime detail report");
    expect(getStatusTool?.description).toContain("detailed runtime status");
    expect(getStatusTool?.description).toContain("router details");
  });

  it("deploy frps uses secure temporary files for the config and systemd unit", async () => {
    try {
      execSyncMock.mockClear();

      const bridge = {
        listDevices() {
          return [];
        },
        getDevice() {
          return null;
        },
      };

      const tool = createClawWRTTools({ bridge: bridge as never }).find(
        (entry) => entry.name === "openclaw_deploy_frps",
      );
      expect(tool).toBeTruthy();

      await tool?.execute?.("tool-deploy", {
        port: 7000,
      });

      const moveCommands = execSyncMock.mock.calls
        .map(([command]) => command)
        .filter(
          (command): command is string =>
            typeof command === "string" && command.startsWith("sudo mv "),
        );

      expect(moveCommands).toHaveLength(2);
      for (const command of moveCommands) {
        const match = command.match(/^sudo mv (\S+) /);
        expect(match?.[1]).toMatch(/^\/tmp\/openclaw-wrt-nwct-/);
        expect(match?.[1]).not.toBe("/tmp/nwct-server.toml");
        expect(match?.[1]).not.toBe("/tmp/nwct-server.service");
      }
    } finally {
      execSyncMock.mockClear();
    }
  });

  it("frps status redacts the auth token from returned config content", async () => {
    execSyncMock.mockClear();

    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
    };

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "openclaw_get_frps_status",
    );
    expect(tool).toBeTruthy();

    const result = await tool?.execute?.("tool-status", {});
    const resultText = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    const details = (result as { details?: Record<string, unknown> }).details;
    const configContent = details?.configContent as string | undefined;

    expect(resultText).toContain('auth.token = "[REDACTED]"');
    expect(resultText).not.toContain("secret-token");
    expect(configContent).toContain('auth.token = "[REDACTED]"');
    expect(configContent).not.toContain("secret-token");
  });

  it("add wg peer uses a secure temp path and avoids shell chaining", async () => {
    execSyncMock.mockClear();
    execFileSyncMock.mockClear();

    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
    };

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "openclaw_add_wg_peer",
    );
    expect(tool).toBeTruthy();

    await tool?.execute?.("tool-wg-peer", {
      publicKey: "PUBLIC_KEY",
      allowedIps: ["10.10.0.2/32"],
      endpoint: "vpn.example.com:51820",
    });

    const mvCommands = execSyncMock.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is string =>
          typeof command === "string" && command.startsWith("sudo mv "),
      );

    expect(mvCommands).toHaveLength(1);
    expect(mvCommands[0]).toContain("/tmp/openclaw-wrt-wg-peer-");
    expect(mvCommands[0]).not.toContain("&&");
    expect(mvCommands[0]).not.toContain("<(");

    expect(execFileSyncMock.mock.calls).toHaveLength(2);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("sudo");
    expect(execFileSyncMock.mock.calls[0][1]).toEqual(["wg-quick", "strip", "wg0"]);
    expect(execFileSyncMock.mock.calls[1][0]).toBe("sudo");
    expect(execFileSyncMock.mock.calls[1][1]).toEqual(["wg", "syncconf", "wg0", "/dev/stdin"]);
  });

  it("portal renderer rejects accentColor values that could break out of style blocks", () => {
    const maliciousAccent = '#123456";}</style><script>alert(1)</script><style>';
    const html = renderPortalPageHtml({
      deviceId: "dev-portal",
      content: {
        accentColor: maliciousAccent,
      },
    });

    expect(html).not.toContain(maliciousAccent);
    expect(html).toContain("#3182ce");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_kickoff_client",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_get_device",
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

  it("auth client tool sends the new auth_client op with client IP and MAC", async () => {
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
        return { type: "auth_client_response", status: "success" };
      },
    };

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_auth_client",
    );
    expect(tool).toBeTruthy();

    const result = await tool?.execute?.("tool-auth", {
      deviceId: "dev-auth",
      clientMac: "aa-bb-cc-dd-ee-ff",
      clientIp: "192.168.1.10",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-auth",
      op: "auth_client",
      payload: {
        client_ip: "192.168.1.10",
        client_mac: "AA:BB:CC:DD:EE:FF",
      },
    });
    expect((result as { details?: Record<string, unknown> }).details?.resolved).toEqual({
      clientIp: "192.168.1.10",
      clientMac: "AA:BB:CC:DD:EE:FF",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_kickoff_client",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_sync_trusted_domains",
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

  it("publishes a portal page into the provided web root and updates the router", async () => {
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
        return { type: "set_local_portal_response", status: "success" };
      },
    };

    const webRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-wrt-portal-"));
    try {
      const tool = createClawWRTTools({ bridge: bridge as never }).find(
        (entry) => entry.name === "clawwrt_publish_portal_page",
      );
      expect(tool).toBeTruthy();

      const html = "<html><body><h1>Welcome</h1></body></html>";
      const result = await tool?.execute?.("tool-portal", {
        deviceId: "dev-portal",
        html,
        webRoot,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        deviceId: "dev-portal",
        op: "set_local_portal",
        payload: {
          portal: "portal-dev-portal.html",
        },
      });
      expect(await readFile(path.join(webRoot, "portal-dev-portal.html"), "utf8")).toBe(html);
      expect((result as { details?: Record<string, unknown> }).details).toMatchObject({
        pageName: "portal-dev-portal.html",
        filePath: path.join(webRoot, "portal-dev-portal.html"),
      });
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("renders a portal template when html is omitted", async () => {
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
        return { type: "set_local_portal_response", status: "success" };
      },
    };

    const webRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-wrt-portal-"));
    try {
      const tool = createClawWRTTools({ bridge: bridge as never }).find(
        (entry) => entry.name === "clawwrt_publish_portal_page",
      );
      expect(tool).toBeTruthy();

      const result = await tool?.execute?.("tool-template", {
        deviceId: "dev-template",
        template: "welcome",
        content: {
          venueName: "龙虾访客网络",
          body: "页面已打开，继续浏览即可。",
          buttonText: "继续浏览",
          footerText: "感谢您的光临。",
        },
        webRoot,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        deviceId: "dev-template",
        op: "set_local_portal",
        payload: {
          portal: "portal-dev-template.html",
        },
      });

      const html = await readFile(path.join(webRoot, "portal-dev-template.html"), "utf8");
      expect(html).toContain("欢迎来到 龙虾访客网络");
      expect(html).toContain("继续浏览");
      expect((result as { details?: Record<string, unknown> }).details).toMatchObject({
        pageName: "portal-dev-template.html",
        template: "welcome",
      });
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("generates a portal page through the template-first tool", async () => {
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
        return { type: "set_local_portal_response", status: "success" };
      },
    };

    const webRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-wrt-portal-"));
    try {
      const tool = createClawWRTTools({ bridge: bridge as never }).find(
        (entry) => entry.name === "clawwrt_generate_portal_page",
      );
      expect(tool).toBeTruthy();

      await tool?.execute?.("tool-generate", {
        deviceId: "dev-generate",
        template: "terms",
        content: {
          brandName: "龙虾网络",
          rules: ["请遵守现场规则。", "如需帮助，请联系工作人员。"],
          buttonText: "同意并继续",
        },
        webRoot,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        deviceId: "dev-generate",
        op: "set_local_portal",
        payload: {
          portal: "portal-dev-generate.html",
        },
      });

      const html = await readFile(path.join(webRoot, "portal-dev-generate.html"), "utf8");
      expect(html).toContain("请先阅读并同意使用条款");
      expect(html).toContain("请遵守现场规则。");
      expect(html).toContain("同意并继续");
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("publishes a portal page with an explicit filename when provided", async () => {
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
        return { type: "set_local_portal_response", status: "success" };
      },
    };

    const webRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-wrt-portal-"));
    try {
      const tool = createClawWRTTools({ bridge: bridge as never }).find(
        (entry) => entry.name === "clawwrt_publish_portal_page",
      );
      expect(tool).toBeTruthy();

      const html = "<html><body><h1>Welcome</h1></body></html>";
      await tool?.execute?.("tool-portal", {
        deviceId: "dev-two",
        html,
        pageName: "loki-dev-two.html",
        webRoot,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        deviceId: "dev-two",
        op: "set_local_portal",
        payload: {
          portal: "loki-dev-two.html",
        },
      });
      expect(await readFile(path.join(webRoot, "loki-dev-two.html"), "utf8")).toBe(html);
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_execute_shell",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_bpf_add",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_bpf_json",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_bpf_json",
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
    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_bpf_del",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_set_wireguard_vpn",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_get_wireguard_vpn_status",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_generate_wireguard_keys",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_bpf_flush",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_bpf_update",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_bpf_update_all",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_get_l7_active_stats",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_get_l7_protocol_catalog",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_set_wireguard_vpn",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_get_vpn_routes",
    );

    await tool?.execute?.("tool-vpnr-get", { deviceId: "dev-vpn" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-vpn",
      op: "get_vpn_routes",
    });
  });

  it("set vpn domain routes sends domains in data payload", async () => {
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
          type: "set_vpn_domain_routes_response",
          interface: "wg0",
          domains: ["example.com"],
          resolved_routes: ["1.2.3.4/32"],
          added: 1,
          failed: 0,
        };
      },
    };

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_set_vpn_domain_routes",
    );

    await tool?.execute?.("tool-vpnd-set", {
      deviceId: "dev-vpn",
      domains: ["example.com", "login.example.net"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-vpn",
      op: "set_vpn_domain_routes",
      payload: {
        data: {
          domains: ["example.com", "login.example.net"],
        },
      },
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_set_vpn_routes",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_set_vpn_routes",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_delete_vpn_routes",
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

    const tool = createClawWRTTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "clawwrt_delete_vpn_routes",
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
