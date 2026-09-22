import type { LookupAddress } from "node:dns";
import type { DispatcherAwareRequestInit } from "openclaw/plugin-sdk/runtime-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSendHarness, type SendHarness } from "./send.handoff.test-support.js";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

vi.mock("./session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-state.js")>()),
  clearStoredZaloCredentials: vi.fn(),
  loadStoredZaloCredentials: vi.fn(),
  loadStoredZaloCredentialsAsync: vi.fn(),
  refreshStoredZaloCredentials: vi.fn(),
  saveStoredZaloCredentials: vi.fn(),
}));

const mediaUrl = "https://media.example.com/document.txt";
const publicAddress = "93.184.216.34";
const mediaBody = "ordinary document fixture";
type PinnedLookup = (
  hostname: string,
  options: { all: true },
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

class FixtureAgent {
  static instances: FixtureAgent[] = [];
  closed = false;
  readonly dispatched: Array<{ origin: string; path: string; method: string }> = [];

  constructor(readonly options: { connect?: { lookup?: PinnedLookup }; uri?: string } = {}) {
    FixtureAgent.instances.push(this);
  }

  dispatch(request: { origin: string; path: string; method: string }, _handler: unknown) {
    this.dispatched.push(request);
    return true;
  }

  async close() {
    this.closed = true;
  }
}

class FixtureEnvHttpProxyAgent extends FixtureAgent {}
class FixtureProxyAgent extends FixtureAgent {}

function mediaResponse() {
  return new Response(mediaBody, {
    headers: { "content-type": "text/plain", "content-length": String(mediaBody.length) },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

let harness: SendHarness;
let ambientDownloads: string[];
let runtimeDownloads: Array<{
  url: string;
  dispatcher: FixtureAgent;
  addresses: LookupAddress[];
}>;

beforeEach(() => {
  FixtureAgent.instances = [];
  harness = createSendHarness({ mediaFixture: false });
  ambientDownloads = [];
  runtimeDownloads = [];
  lookup.mockReset().mockResolvedValue([{ address: publicAddress, family: 4 }]);
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(name, undefined);
  }
  // Model an ambient runtime fetch that accepts but ignores the dispatcher option.
  const ambientFetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.href === mediaUrl) {
      ambientDownloads.push(url.href);
      return mediaResponse();
    }
    return harness.fetch(input, init);
  };
  vi.stubGlobal("fetch", ambientFetch);
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
    Agent: FixtureAgent,
    EnvHttpProxyAgent: FixtureEnvHttpProxyAgent,
    ProxyAgent: FixtureProxyAgent,
    fetch: async (input: Parameters<typeof fetch>[0], init?: DispatcherAwareRequestInit) => {
      const url = requestUrl(input);
      const dispatcher = init?.dispatcher;
      if (!(dispatcher instanceof FixtureAgent)) {
        throw new Error("Expected the guarded runtime dispatcher");
      }
      const pinnedLookup = dispatcher.options.connect?.lookup;
      if (!pinnedLookup && !(dispatcher instanceof FixtureEnvHttpProxyAgent)) {
        throw new Error("Expected pinned DNS on the runtime dispatcher");
      }
      const addresses = pinnedLookup
        ? await new Promise<LookupAddress[]>((resolve, reject) => {
            pinnedLookup(url.hostname, { all: true }, (error, resolved) => {
              if (error) {
                reject(error);
              } else {
                resolve(resolved);
              }
            });
          })
        : [];
      dispatcher.dispatch(
        { origin: url.origin, path: url.pathname + url.search, method: init?.method ?? "GET" },
        {},
      );
      runtimeDownloads.push({ url: url.href, dispatcher, addresses });
      return mediaResponse();
    },
  });
});

afterEach(async () => {
  try {
    await harness.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("Zalouser guarded media handoff", () => {
  it("downloads through the pinned runtime dispatcher and delivers with the SDK", async () => {
    const result = await harness.send("message.media", { text: "", mediaUrl });
    expect(result.messageId).toBe("message-1");
    expect(runtimeDownloads).toEqual([
      {
        url: mediaUrl,
        dispatcher: expect.any(FixtureAgent),
        addresses: [{ address: publicAddress, family: 4 }],
      },
    ]);
    expect(runtimeDownloads[0]?.dispatcher.closed).toBe(true);
    expect(ambientDownloads).toEqual([]);
    expect(harness.requests.map(({ path }) => path)).toEqual([
      "/api/message/asyncfile/upload",
      "/api/message/asyncfile/msg",
    ]);
  });

  it("makes no media or SDK request after cancellation during guarded DNS preparation", async () => {
    const dns = harness.gate();
    lookup.mockImplementation(async () => {
      dns.entered.resolve();
      await dns.release.promise;
      return [{ address: publicAddress, family: 4 }];
    });
    const caller = new AbortController();
    const send = harness.send("message.media", { text: "", mediaUrl, signal: caller.signal });
    await dns.entered.promise;
    caller.abort(new Error("media caller canceled"));
    dns.release.resolve();
    await expect(send).rejects.toThrow("media caller canceled");
    expect(runtimeDownloads).toEqual([]);
    expect(ambientDownloads).toEqual([]);
    expect(harness.requests).toEqual([]);
  });

  it("preserves the existing managed proxy route through the runtime dispatcher", async () => {
    const proxyUrl = "http://proxy.example.com:8080";
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", "/__openclaw_zalouser_test__/absent-ca.pem");
    vi.stubEnv("HTTPS_PROXY", proxyUrl);
    const result = await harness.send("message.media", { text: "", mediaUrl });
    expect(result.messageId).toBe("message-1");
    expect(runtimeDownloads).toEqual([
      { url: mediaUrl, dispatcher: expect.any(FixtureEnvHttpProxyAgent), addresses: [] },
    ]);
    const proxies = FixtureAgent.instances.filter((agent) => agent instanceof FixtureProxyAgent);
    expect(
      proxies.map(({ options, dispatched, closed }) => ({ uri: options.uri, dispatched, closed })),
    ).toEqual([
      {
        uri: proxyUrl,
        dispatched: [{ origin: "https://media.example.com", path: "/document.txt", method: "GET" }],
        closed: true,
      },
    ]);
    expect(runtimeDownloads[0]?.dispatcher.closed).toBe(true);
    expect(ambientDownloads).toEqual([]);
    expect(harness.requests.map(({ path }) => path)).toEqual([
      "/api/message/asyncfile/upload",
      "/api/message/asyncfile/msg",
    ]);
  });
});
