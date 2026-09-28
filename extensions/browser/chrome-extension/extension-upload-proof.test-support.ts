/**
 * Real extension-profile upload proof support.
 *
 * Exercises the file-chooser upload route through the production `driver:
 * "extension"` stack (real Chromium, unpacked extension, owned relay) and
 * observes the CDP commands clients send across the relay, so the proof can
 * show which upload route Playwright took on each side of the relay-safe
 * payload bound.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { EXTENSION_RELAY_MAX_PAYLOAD_BYTES } from "../src/browser/constants.js";
import type { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import { DEFAULT_UPLOAD_DIR } from "../src/browser/paths.js";
import type { createBrowserRouteDispatcher } from "../src/browser/routes/dispatcher.js";

type ProofParams = {
  dispatcher: ReturnType<typeof createBrowserRouteDispatcher>;
  context: { newPage: () => Promise<Page> };
  /** Serves the proof page; the gateway fixture's /browser-owner-proof route. */
  gatewayPort: number;
  relaySentCommands: string[];
  /** Suite cleanup collector; proof files register here when written. */
  addCleanup: (dispose: () => Promise<void>) => void;
  resolved: { ssrfPolicy?: unknown };
};

/**
 * Start recording every CDP command clients send across the relay.
 *
 * Install this before the first dispatcher call so the recorder sees every
 * client socket the harness attaches, not only later ones.
 */
export function startRelayCommandRecorder(relay: {
  bridge: Pick<ExtensionRelayBridge, "attachCdpClientSocket">;
}): { relaySentCommands: string[] } {
  const relaySentCommands: string[] = [];
  const relayBridge = relay.bridge;
  const originalAttachCdpClientSocket = relayBridge.attachCdpClientSocket.bind(relayBridge);
  relayBridge.attachCdpClientSocket = (socket) => {
    const handlers = originalAttachCdpClientSocket(socket);
    return {
      onMessage: (raw) => {
        relaySentCommands.push(raw);
        handlers.onMessage(raw);
      },
      onClose: handlers.onClose,
    };
  };
  return { relaySentCommands };
}

async function readUploadedFile(page: Page): Promise<{ name: string; size: number } | null> {
  return await page
    .locator("#upload")
    .evaluate((input: HTMLInputElement) =>
      input.files?.[0] ? { name: input.files[0].name, size: input.files[0].size } : null,
    );
}

/**
 * Prove the extension upload routes against the real relay.
 *
 * 1. a small file reaches the input as byte payloads, with no
 *    DOM.setFileInputFiles path command crossing the relay;
 * 2. a file just below the relay-safe bound still crosses as bytes;
 * 3. a file at or above the bound falls back to the local path handoff
 *    (DOM.setFileInputFiles crosses the relay), so file-access extensions
 *    keep the large uploads they had before extension profiles moved to
 *    payloads.
 */
export async function proveExtensionUploadRoutes(params: ProofParams): Promise<void> {
  const { dispatcher, context, gatewayPort, relaySentCommands, addCleanup, resolved } = params;
  const uploadProofFile = path.join(DEFAULT_UPLOAD_DIR, `extension-upload-proof-${Date.now()}.txt`);
  await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
  const uploadProofContents = `extension payload proof ${Date.now()}`;
  await fs.writeFile(uploadProofFile, uploadProofContents);
  addCleanup(async () => await fs.rm(uploadProofFile, { force: true }));
  const uploadProofPage = await context.newPage();
  await uploadProofPage.goto(`http://127.0.0.1:${gatewayPort}/browser-owner-proof`);
  await uploadProofPage.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "upload";
    document.body.append(input);
  });
  const uploadProofSsrfPolicy = resolved.ssrfPolicy;
  resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: true };
  try {
    // Playwright reports the page before the extension's tab index lists it
    // (the same race assertRelayTabCreation accommodates), so poll for the tab.
    let uploadTargetId: string | undefined;
    await expect
      .poll(
        async () => {
          const uploadTabsResponse = await dispatcher.dispatch({
            method: "GET",
            path: "/tabs",
            query: { profile: "e2e" },
          });
          if (uploadTabsResponse.status !== 200) {
            return false;
          }
          uploadTargetId = (
            uploadTabsResponse.body as { tabs?: Array<{ targetId?: string; url?: string }> }
          ).tabs?.find((tab) => tab.url === uploadProofPage.url())?.targetId;
          return uploadTargetId !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    if (!uploadTargetId) {
      throw new Error("Extension upload proof tab never appeared in /tabs");
    }
    const uploadResponse = await dispatcher.dispatch({
      method: "POST",
      path: "/hooks/file-chooser",
      query: { profile: "e2e" },
      body: { targetId: uploadTargetId, element: "#upload", paths: [uploadProofFile] },
    });
    expect(uploadResponse.status, JSON.stringify(uploadResponse.body)).toBe(200);
    expect(await readUploadedFile(uploadProofPage)).toEqual({
      name: path.basename(uploadProofFile),
      size: Buffer.byteLength(uploadProofContents),
    });
    expect(
      relaySentCommands.some((command) => command.includes("DOM.setFileInputFiles")),
      "extension upload must not relay a local path to DOM.setFileInputFiles",
    ).toBe(false);
    process.stderr.write(
      "[browser-extension-e2e] extension upload proof passed: payload branch, no DOM.setFileInputFiles relayed\n",
    );

    // A file near 48 MiB becomes ~64 MiB once base64 encoded, which the relay's
    // 64 MiB WebSocket message cap rejects, so byte payloads stop being
    // relay-safe before Playwright's own 50 MiB payload cap. Exercise both sides.
    // Must stay in sync with the module-private bound in
    // pw-tools-core.interactions.content.ts: three quarters of the relay
    // message cap, minus JSON-framing headroom.
    const relaySafeBound = Math.floor((EXTENSION_RELAY_MAX_PAYLOAD_BYTES * 3) / 4) - 1024 * 1024;
    // Below the bound: bytes cross the relay (no DOM.setFileInputFiles) and land.
    const payloadSideSize = relaySafeBound - 1024 * 1024;
    const payloadSideFile = path.join(
      DEFAULT_UPLOAD_DIR,
      `extension-relay-payload-side-proof-${Date.now()}.bin`,
    );
    await fs.writeFile(payloadSideFile, Buffer.alloc(payloadSideSize, 7));
    addCleanup(async () => await fs.rm(payloadSideFile, { force: true }));
    const relayCommandsBeforePayloadSide = relaySentCommands.length;
    const payloadSideResponse = await dispatcher.dispatch({
      method: "POST",
      path: "/hooks/file-chooser",
      query: { profile: "e2e" },
      body: { targetId: uploadTargetId, element: "#upload", paths: [payloadSideFile] },
    });
    expect(payloadSideResponse.status, JSON.stringify(payloadSideResponse.body)).toBe(200);
    expect(await readUploadedFile(uploadProofPage)).toEqual({
      name: path.basename(payloadSideFile),
      size: payloadSideSize,
    });
    expect(
      relaySentCommands
        .slice(relayCommandsBeforePayloadSide)
        .some((command) => command.includes("DOM.setFileInputFiles")),
      "extension upload below the relay-safe bound must stay on the byte-payload branch",
    ).toBe(false);
    process.stderr.write(
      `[browser-extension-e2e] relay-boundary payload side proof passed: ${(
        payloadSideSize /
        (1024 * 1024)
      ).toFixed(0)} MiB crossed as bytes\n`,
    );
    // At/above the bound: the path handoff takes over (DOM.setFileInputFiles
    // crosses the relay), so file-access extensions keep these uploads.
    const pathSideSize = relaySafeBound + 64 * 1024;
    const pathSideFile = path.join(
      DEFAULT_UPLOAD_DIR,
      `extension-relay-path-side-proof-${Date.now()}.bin`,
    );
    await fs.writeFile(pathSideFile, Buffer.alloc(pathSideSize, 7));
    addCleanup(async () => await fs.rm(pathSideFile, { force: true }));
    const relayCommandsBeforePathSide = relaySentCommands.length;
    const pathSideResponse = await dispatcher.dispatch({
      method: "POST",
      path: "/hooks/file-chooser",
      query: { profile: "e2e" },
      body: { targetId: uploadTargetId, element: "#upload", paths: [pathSideFile] },
    });
    expect(pathSideResponse.status, JSON.stringify(pathSideResponse.body)).toBe(200);
    expect(await readUploadedFile(uploadProofPage)).toEqual({
      name: path.basename(pathSideFile),
      size: pathSideSize,
    });
    expect(
      relaySentCommands
        .slice(relayCommandsBeforePathSide)
        .some((command) => command.includes("DOM.setFileInputFiles")),
      "extension upload at the relay-safe bound should fall back to the local path handoff",
    ).toBe(true);
    process.stderr.write(
      `[browser-extension-e2e] relay-boundary path side proof passed: ${(
        pathSideSize /
        (1024 * 1024)
      ).toFixed(0)} MiB preserved via path handoff\n`,
    );
  } finally {
    resolved.ssrfPolicy = uploadProofSsrfPolicy;
  }
}
