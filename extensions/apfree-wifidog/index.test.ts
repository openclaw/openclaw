import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("apfree-wifidog plugin registration", () => {
  it("registers multiple intent-specific tools", async () => {
    const registerTool = vi.fn();
    const on = vi.fn();

    plugin.register?.(
      createTestPluginApi({
        id: "apfree-wifidog",
        name: "ApFree WiFiDog",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerTool,
        registerService() {},
        on,
      }),
    );

    const toolNames = registerTool.mock.calls.flatMap((call) => {
      const toolOrFactory = call[0];
      const tools = typeof toolOrFactory === "function" ? toolOrFactory() : toolOrFactory;
      const toolArray = Array.isArray(tools) ? tools : [tools];
      return toolArray.map((t) => t.name);
    });

    expect(toolNames).toContain("apfree_wifidog_list_devices");
    expect(toolNames).toContain("apfree_wifidog_get_status");
    expect(toolNames).toContain("apfree_wifidog_get_sys_info");
    expect(toolNames).toContain("apfree_wifidog_get_clients");
    expect(toolNames).toContain("apfree_wifidog_kickoff_client");
    expect(toolNames).toContain("apfree_wifidog_sync_trusted_domains");
    expect(toolNames).toContain("apfree_wifidog_set_auth_serv");
    expect(toolNames).toContain("apfree_wifidog_bpf_add");
    expect(toolNames).toContain("apfree_wifidog_bpf_json");
    expect(toolNames).toContain("apfree_wifidog_bpf_del");
    expect(toolNames).toContain("apfree_wifidog_bpf_flush");
    expect(toolNames).toContain("apfree_wifidog_bpf_update");
    expect(toolNames).toContain("apfree_wifidog_bpf_update_all");
    expect(toolNames).toContain("apfree_wifidog_get_l7_active_stats");
    expect(toolNames).toContain("apfree_wifidog_get_l7_protocol_catalog");
    expect(toolNames).toContain("apfree_wifidog_execute_shell");
    expect(toolNames).toContain("apfree_wifidog");

    expect(on).not.toHaveBeenCalled();
  });

  it("declares integer-only numeric config fields in the manifest schema", () => {
    const properties = manifest.configSchema.properties;

    expect(properties.port?.type).toBe("integer");
    expect(properties.requestTimeoutMs?.type).toBe("integer");
    expect(properties.maxPayloadBytes?.type).toBe("integer");
    expect(properties.awasPort?.type).toBe("integer");
  });
});
