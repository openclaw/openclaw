import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import { downloadCurrentDocumentViaPlaywright } from "./pw-tools-core.downloads.js";

// Only source DNS is synthetic. The real policy owner validates its public answer;
// Chromium maps that test hostname to our loopback fixture, never the public Internet.
vi.mock("../infra/net/ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/ssrf.js")>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: (
      hostname: string,
      params: Parameters<typeof actual.resolvePinnedHostnameWithPolicy>[1] = {},
    ) =>
      actual.resolvePinnedHostnameWithPolicy(hostname, {
        ...params,
        ...(hostname === "download-source.test"
          ? { lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] }
          : {}),
      }),
  };
});

const sourceHostname = "download-source.test";
const restrictedPolicies: { name: string; policy: SsrFPolicy | undefined }[] = [
  { name: "omitted policy", policy: undefined },
  { name: "default empty policy", policy: {} },
  {
    name: "private denied with a trusted starting host",
    policy: {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: [sourceHostname],
    },
  },
  { name: "host-only private exception", policy: { allowedHostnames: [sourceHostname] } },
  {
    name: "hostname allowlist with private access",
    policy: {
      dangerouslyAllowPrivateNetwork: true,
      hostnameAllowlist: [sourceHostname],
    },
  },
  {
    name: "hostname blocklist with private access",
    policy: {
      dangerouslyAllowPrivateNetwork: true,
      blockedHostnames: ["127.0.0.1"],
    },
  },
];

describe.skipIf(!isLiveTestEnabled())("uninspectable download policy (real Chromium)", () => {
  let context: BrowserContext;
  let page: Page;
  let rootDir: string;
  let cdpUrl: string;
  let targetId: string;
  let sourceUrl: string;
  let destinationUrl: string;
  let bytes: Buffer;
  let redirect = false;
  let sourceRequests = 0;
  let destinationRequests = 0;
  let destinationConnections = 0;
  const source = createServer((_req, res) => {
    sourceRequests += 1;
    if (redirect) {
      res.writeHead(302, { Location: destinationUrl }).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }).end(bytes);
  });
  const destination = createServer((_req, res) => {
    destinationRequests += 1;
    res
      .writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="redirected.png"',
      })
      .end(bytes);
  });
  destination.on("connection", () => {
    destinationConnections += 1;
  });

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-policy-live-"));
    bytes = await fs.readFile(new URL("../../assets/icon.png", import.meta.url));
    destination.listen(0, "127.0.0.1");
    await once(destination, "listening");
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    const sourceAddress = source.address();
    const destinationAddress = destination.address();
    if (
      !sourceAddress ||
      typeof sourceAddress === "string" ||
      !destinationAddress ||
      typeof destinationAddress === "string"
    ) {
      throw new Error("Fixture servers did not bind");
    }
    sourceUrl = `http://${sourceHostname}:${sourceAddress.port}/asset.png`;
    destinationUrl = `http://127.0.0.1:${destinationAddress.port}/redirected.png`;
    const profileDir = path.join(rootDir, "chromium-profile");
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      acceptDownloads: true,
      args: [
        "--remote-debugging-port=0",
        "--no-proxy-server",
        `--host-resolver-rules=MAP ${sourceHostname} 127.0.0.1`,
      ],
    });
    const port = (await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split(
      "\n",
    )[0];
    cdpUrl = `http://127.0.0.1:${port}`;
    page = await context.newPage();
    const session = await context.newCDPSession(page);
    ({
      targetInfo: { targetId },
    } = await session.send("Target.getTargetInfo"));
    await session.detach();
    // Exercise an already-active CDP session, not an unrelated connection-policy refusal.
    await getPageForTargetId({
      cdpUrl,
      targetId,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
  }, 30_000);

  afterAll(async () => {
    await closePlaywrightBrowserConnection({ cdpUrl });
    await context?.close();
    for (const server of [source, destination]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function displaySource() {
    redirect = false;
    await page.goto(sourceUrl);
    expect(page.url()).toBe(sourceUrl);
    redirect = true;
  }

  function save(policy?: SsrFPolicy) {
    return downloadCurrentDocumentViaPlaywright({
      cdpUrl,
      targetId,
      expectedUrl: sourceUrl,
      rootDir: path.join(rootDir, "downloads"),
      ssrfPolicy: policy,
      timeoutMs: 10_000,
    });
  }

  it.each(restrictedPolicies)(
    "refuses $name before any trigger or destination I/O",
    async ({ name, policy }) => {
      await displaySource();
      await expect(
        assertBrowserNavigationAllowed({ url: sourceUrl, ssrfPolicy: policy }),
      ).resolves.toBeUndefined();
      await expect(
        assertBrowserNavigationAllowed({ url: destinationUrl, ssrfPolicy: policy }),
      ).rejects.toThrow();
      const initialSourceRequests = sourceRequests;
      const initialDestinationRequests = destinationRequests;
      const initialDestinationConnections = destinationConnections;
      let error: unknown;
      try {
        await save(policy);
      } catch (caught) {
        error = caught;
      }
      const traffic = {
        sourceRequests: sourceRequests - initialSourceRequests,
        destinationRequests: destinationRequests - initialDestinationRequests,
        destinationConnections: destinationConnections - initialDestinationConnections,
      };
      console.info(JSON.stringify({ policy: name, startingUrlAllowed: true, ...traffic }));
      expect(traffic).toEqual({
        sourceRequests: 0,
        destinationRequests: 0,
        destinationConnections: 0,
      });
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("download redirects cannot be inspected"),
      );
      expect(page.url()).toBe(sourceUrl);
    },
    15_000,
  );

  it("follows that same redirect and saves exact bytes only with an unrestricted policy", async () => {
    await displaySource();
    const initialSourceRequests = sourceRequests;
    const result = await save({ dangerouslyAllowPrivateNetwork: true });
    expect(sourceRequests).toBe(initialSourceRequests + 1);
    expect(destinationRequests).toBeGreaterThan(0);
    expect(destinationConnections).toBeGreaterThan(0);
    expect(await fs.readFile(result.path)).toEqual(bytes);
    expect(page.url()).toBe(sourceUrl);
    console.info(
      JSON.stringify({
        policy: "explicitly unrestricted",
        bytes: bytes.length,
        destinationRequests,
        destinationConnections,
      }),
    );
  }, 15_000);
});
