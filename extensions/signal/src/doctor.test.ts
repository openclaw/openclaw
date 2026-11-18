import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { signalDoctor } from "./doctor.js";

const proxyEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  https_proxy: ["http://synthetic-user", "synthetic-pass@proxy.invalid:3128"].join(":"),
  NODE_EXTRA_CA_CERTS: "/srv/synthetic-ca/bundle.pem",
  OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token",
  OPENAI_API_KEY: "synthetic-provider-key",
};

function signalConfig(signal: Record<string, unknown>): OpenClawConfig {
  return { channels: { signal } } as OpenClawConfig;
}

async function collectSignalDaemonEnvNotes(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  const result = await signalDoctor.runConfigSequence?.({ ...params, shouldRepair: false });
  if (!result) {
    throw new Error("Signal doctor must provide a config sequence");
  }
  return result;
}

describe("signal doctor managed daemon environment note", () => {
  it("warns by name when a managed daemon will not inherit proxy or CA variables", async () => {
    const result = await collectSignalDaemonEnvNotes({
      cfg: signalConfig({ account: "+15550000001", transport: { kind: "managed-native" } }),
      env: proxyEnv,
    });

    expect(result.changeNotes).toEqual([]);
    expect(result.warningNotes).toHaveLength(1);
    const note = result.warningNotes[0];
    expect(note).toContain("channels.signal:");
    expect(note).toContain("NODE_EXTRA_CA_CERTS, https_proxy");
    expect(note).toContain("JAVA_TOOL_OPTIONS");
    expect(note).toContain("https://docs.openclaw.ai/channels/signal#managed-daemon-environment");
    expect(note).not.toContain("synthetic-");
    expect(note).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(note).not.toContain("OPENAI_API_KEY");
  });

  it("covers named accounts on the implicit managed transport", async () => {
    const result = await collectSignalDaemonEnvNotes({
      cfg: signalConfig({ accounts: { work: { account: "+15550000002" } } }),
      env: proxyEnv,
    });

    expect(result.warningNotes).toHaveLength(1);
  });

  it("stays quiet when no proxy or CA variables are set", async () => {
    const result = await collectSignalDaemonEnvNotes({
      cfg: signalConfig({ account: "+15550000001", transport: { kind: "managed-native" } }),
      env: { PATH: "/usr/bin", HTTPS_PROXY: "", OPENCLAW_GATEWAY_TOKEN: "synthetic" },
    });

    expect(result.warningNotes).toEqual([]);
  });

  it("stays quiet when Signal does not run a managed daemon", async () => {
    for (const cfg of [
      {} as OpenClawConfig,
      signalConfig({
        account: "+15550000001",
        transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
      }),
      signalConfig({
        account: "+15550000001",
        transport: { kind: "container", url: "http://127.0.0.1:8080" },
      }),
      signalConfig({
        enabled: false,
        account: "+15550000001",
        transport: { kind: "managed-native" },
      }),
    ]) {
      expect((await collectSignalDaemonEnvNotes({ cfg, env: proxyEnv })).warningNotes).toEqual([]);
    }
  });
});
