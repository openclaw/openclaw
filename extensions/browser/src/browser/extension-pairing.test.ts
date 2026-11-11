import { beforeEach, expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { buildBrowserExtensionPairing as buildPairing } from "./extension-pairing.js";
import { ensureExtensionRelayToken } from "./extension-relay/relay-auth.js";

vi.mock("./extension-relay/relay-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extension-relay/relay-auth.js")>();
  return { ...actual, ensureExtensionRelayToken: vi.fn(actual.ensureExtensionRelayToken) };
});

const RELAY_KEY = relayTestKey(5);
const extensionProfile = (cdpPort: number) => ({ driver: "extension" as const, cdpPort });
const gatewayTransport = { localTransport: "gateway" as const };
beforeEach(() => {
  vi.mocked(ensureExtensionRelayToken).mockResolvedValue(RELAY_KEY);
});

it("binds native bootstrap to the selected profile instead of the first extension relay", async () => {
  const cfg = {
    browser: {
      defaultProfile: "work",
      profiles: {
        first: extensionProfile(19441),
        work: extensionProfile(19442),
      },
    },
  };
  const legacy = await buildPairing({ cfg, ...gatewayTransport });
  expect(legacy.relayPort).toBe(19441);
  expect(new URL(legacy.pairingString).searchParams.has("profile")).toBe(false);
  const result = await buildPairing({ cfg, profile: "work", ...gatewayTransport });
  expect(result.relayPort).toBe(19442);
  expect(new URL(result.pairingString).searchParams.get("profile")).toBe("work");
  await expect(buildPairing({ cfg, profile: "missing" })).rejects.toThrow(
    "existing extension profile",
  );
});

it.each(["browser-node", "direct-remote"] as const)(
  "routes %s pairing to the correct host",
  async (topology) => {
    const direct = topology === "direct-remote";
    const relayPort = direct ? 19197 : 19198;
    const gatewayUrl = direct ? "wss://gateway.example.com:9443" : "wss://gateway.example.com:9444";
    const browser = { profiles: { chrome: extensionProfile(relayPort) } };
    const params = direct
      ? { cfg: { browser }, gatewayUrl }
      : {
          cfg: { browser, gateway: { mode: "remote" as const, remote: { url: gatewayUrl } } },
        };
    await expect(buildPairing(params)).resolves.toEqual({
      pairingString: direct
        ? `wss://gateway.example.com:9443/browser/extension?gateway=wss%3A%2F%2Fgateway.example.com%3A9443#${RELAY_KEY}`
        : `ws://127.0.0.1:19198/extension?gateway=wss%3A%2F%2Fgateway.example.com%3A9444#${RELAY_KEY}`,
      relayPort,
      topology,
    });
  },
);

it("requires an explicit certificate hostname for local Gateway TLS", async () => {
  await expect(buildPairing({ cfg: { gateway: { tls: { enabled: true } } } })).rejects.toThrow(
    "--gateway-url wss://<certificate-host>",
  );
});
