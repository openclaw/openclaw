import { expect, it, vi } from "vitest";
import {
  getBrowserControlServerBaseUrl,
  getCdpMocks,
  getBrowserControlServerTestState,
  setBrowserControlServerProfiles,
  installBrowserControlServerHooks,
  makeResponse,
  setBrowserControlServerReachable,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

const { launchOpenClawChrome, stopOpenClawChrome } = await import("./chrome.js");

installBrowserControlServerHooks();
async function start(reachable = false) {
  await startBrowserControlServerFromConfig();
  setBrowserControlServerReachable(reachable);
  vi.mocked(launchOpenClawChrome).mockClear();
}

async function request(path: string, body?: unknown) {
  const init =
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
  return await getBrowserTestFetch()(`${getBrowserControlServerBaseUrl()}${path}`, init);
}
async function expectResponse(response: Response, status: number, body: object) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject(body);
}
const screenshot = () => request("/screenshot", { targetId: "closed-historical-tab" });

it.each([
  [false, true],
  [true, false],
  [true, true],
])("preserves historical tabs (running: %s, empty: %s)", async (running, empty) => {
  await start(running);
  vi.mocked(stopOpenClawChrome).mockClear();
  const fetchCdp = globalThis.fetch;
  const tabRequests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      tabRequests.push(url);
      return empty && url.includes("/json/list") ? makeResponse([]) : await fetchCdp(input, init);
    }),
  );

  await expectResponse(await screenshot(), running ? 404 : 409, {
    error: expect.stringContaining(running ? "not found" : "not running"),
  });
  expect(getCdpMocks().createTargetViaCdp).not.toHaveBeenCalled();
  expect(launchOpenClawChrome).not.toHaveBeenCalled();
  expect(stopOpenClawChrome).not.toHaveBeenCalled();
  expect(tabRequests.some((url) => url.includes("/json/new"))).toBe(false);
  expect(await (await request("/tabs")).json()).toMatchObject({
    running,
    tabs: empty ? [] : expect.arrayContaining([expect.objectContaining({ targetId: "abcd1234" })]),
  });
});

it("still resolves a live tab alias", async () => {
  await start(true);
  await expectResponse(await request("/snapshot?targetId=t1&format=ai"), 200, {
    targetId: "abcd1234",
  });
});

it("preserves intentional startup when opening a tab", async () => {
  await start();
  getCdpMocks().createTargetViaCdp.mockResolvedValue({
    targetId: "abcd1234",
    finalUrl: "https://example.com",
  });

  const response = await request("/tabs/open", { url: "about:blank" });

  expect(response.status).toBe(200);
  expect(launchOpenClawChrome).toHaveBeenCalledOnce();
});

it("uses a changed default on the first request through the same HTTP server", async () => {
  const profiles = {
    ...getBrowserControlServerTestState().cfgProfiles,
    work: { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" },
  };
  setBrowserControlServerProfiles(profiles, "openclaw");
  const server = await startBrowserControlServerFromConfig();
  for (const defaultProfile of ["openclaw", "work", "openclaw"]) {
    setBrowserControlServerProfiles(profiles, defaultProfile);
    await expectResponse(await request("/"), 200, { profile: defaultProfile });
    expect(await startBrowserControlServerFromConfig()).toBe(server);
  }
});
