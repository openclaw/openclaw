import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.ts";
import {
  createControlUiE2eSuite,
  tooltipTitleText,
} from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { createQaGatewayChild } from "../api.ts";

const COMMAND = "codex.exec-server.stdio.v1";
const MODEL = "openai/gpt-5.6-luna";
const REQUEST_TIMEOUT_MS = 20_000;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const helloCounts = new WeakMap<GatewayClient, number>();

const gatewayOwners: ReturnType<typeof createQaGatewayChild>[] = [];
type DeviceIdentity = ReturnType<typeof createDeviceIdentity>;

afterEach(async () => {
  for (const owner of gatewayOwners.splice(0)) {
    const stopped = await owner.stop();
    if (stopped.errors.length > 0) {
      throw new AggregateError(stopped.errors, "QA Gateway cleanup failed");
    }
  }
});

const suite = createControlUiE2eSuite({
  name: "Session host command state with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it(
    "shows the next action for every required node command state",
    { timeout: 180_000 },
    async () => {
      const gatewayOwner = createQaGatewayChild();
      gatewayOwners.push(gatewayOwner);
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        transportBaseUrl: "http://127.0.0.1",
        providerMode: "mock-openai",
        providerBaseUrl: "http://127.0.0.1:9/v1",
        primaryModel: MODEL,
        alternateModel: MODEL,
        forcedRuntime: "codex",
        enabledPluginIds: ["codex"],
        controlUiEnabled: false,
        mutateConfig: (config) => {
          const gatewayConfig = (config.gateway ??= {});
          gatewayConfig.auth = { mode: "none" };
          Object.assign((gatewayConfig.controlUi ??= {}), {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          });
          const nodes = (gatewayConfig.nodes ??= {});
          nodes.commands = { allow: [COMMAND] };
          Object.assign((nodes.pairing ??= {}), { autoApproveLocal: false, sshVerify: false });
          gatewayConfig.reload = { mode: "hybrid" };
          const defaults = ((config.agents ??= {}).defaults ??= {});
          (defaults.models ??= {})[MODEL] = { agentRuntime: { id: "codex" } };
          return config;
        },
      });
      const operator = await connectClient(gateway);
      const clients: GatewayClient[] = [operator];
      try {
        const undeclaredIdentity = createDeviceIdentity();
        const pendingIdentity = createDeviceIdentity();
        const unauthorizedIdentity = createDeviceIdentity();
        const undeclaredMessage =
          "This model uses the Codex harness, which is unavailable on this device. Install it on that node (openclaw plugins install @openclaw/codex), or enable an existing install (openclaw plugins enable codex). Then restart the node (openclaw node restart) and approve its updated command surface, or choose a model using the OpenClaw harness.";
        const pendingMessage = `paired-device command ${COMMAND} is awaiting pairing approval for node ${pendingIdentity.deviceId}; find its updated command surface request with openclaw nodes pending, then run openclaw nodes approve <requestId>`;
        const unauthorizedMessage = `paired-device command ${COMMAND} is blocked by Gateway policy for node ${unauthorizedIdentity.deviceId}; allow it in gateway.nodes.commands.allow and remove any matching gateway.nodes.commands.deny entry`;

        const nodeParams = (
          identity: DeviceIdentity,
          displayName: string,
          commands: string[] = [],
        ) => ({
          gateway,
          operator,
          identity,
          displayName,
          commands,
        });
        const undeclaredNode = await connectPairedNode(
          nodeParams(undeclaredIdentity, "Undeclared command"),
        );
        clients.push(undeclaredNode);
        await publishSessionHost(undeclaredNode);
        const pendingParams = nodeParams(pendingIdentity, "Pending approval");
        const pendingApproved = await connectPairedNode(pendingParams);
        await pendingApproved.stopAndWait({ timeoutMs: 1_000 });
        const pendingNode = await connectClient(gateway, { ...pendingParams, commands: [COMMAND] });
        clients.push(pendingNode);
        await publishSessionHost(pendingNode);
        await waitForPendingCommand(operator, pendingIdentity.deviceId);
        const unauthorizedNode = await connectPairedNode(
          nodeParams(unauthorizedIdentity, "Unauthorized command", [COMMAND]),
        );
        clients.push(unauthorizedNode);
        await publishSessionHost(unauthorizedNode);

        const expectState = async (identity: DeviceIdentity, state: string, message?: string) => {
          const inventory = await operator.request<{
            environments: Array<{
              id: string;
              requiredNodeCommand?: { command: string; state: string; message?: string };
            }>;
          }>("environments.list", { runtimeId: "codex" });
          const environment = inventory.environments.find(
            ({ id }) => id === `node:${identity.deviceId}`,
          );
          expect(environment?.requiredNodeCommand).toEqual({
            command: COMMAND,
            state,
            ...(message === undefined ? {} : { message }),
          });
        };
        const setCommands = async (allow: string[], deny: string[]) => {
          const config = await operator.request<{ hash: string }>("config.get", {});
          await operator.request("config.patch", {
            raw: JSON.stringify({ gateway: { nodes: { commands: { allow, deny } } } }),
            baseHash: config.hash,
            replacePaths: ["gateway.nodes.commands.allow", "gateway.nodes.commands.deny"],
          });
        };
        await expectState(undeclaredIdentity, "undeclared", undeclaredMessage);
        await expectState(pendingIdentity, "pending-approval", pendingMessage);
        await expectState(unauthorizedIdentity, "invocable");

        await suite.withPage(
          {
            locale: "en-US",
            ...(captureUiProof
              ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1440 } } }
              : {}),
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
          },
          async ({ page }) => {
            const url = new URL("new", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", gateway.wsUrl);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation.getByRole("button", { name: /^Switch to /u }).click();

            await page.locator("#new-session-where-trigger").click();
            const place = page.locator(".oc-popover.new-session-page__where-popover");
            const row = (deviceId: string) => place.locator(`[data-value="device:${deviceId}"]`);
            const disabledReason = async (deviceId: string) => tooltipTitleText(row(deviceId));
            const capture = async (name: string) => {
              if (captureUiProof) {
                // Preserve the viewport: full-page captures resize the shared screencast surface.
                await page.screenshot({
                  animations: "disabled",
                  path: path.join(suite.artifactDir, name),
                });
              }
            };

            await row(undeclaredIdentity.deviceId).waitFor();
            expect(await disabledReason(undeclaredIdentity.deviceId)).toContain(undeclaredMessage);
            await expect
              .poll(() => disabledReason(pendingIdentity.deviceId))
              .toContain(pendingMessage);
            await capture("00-undeclared.png");
            await capture("01-pending-approval.png");
            await page.keyboard.press("Escape");

            const unauthorizedHelloCount = helloCounts.get(unauthorizedNode) ?? 0;
            await setCommands([], [COMMAND]);
            await vi.waitFor(
              () => expectState(unauthorizedIdentity, "unauthorized", unauthorizedMessage),
              { interval: 250, timeout: 60_000 },
            );
            expect(helloCounts.get(unauthorizedNode)).toBe(unauthorizedHelloCount);

            await page.reload();
            await page.locator("#new-session-where-trigger").click();
            await row(unauthorizedIdentity.deviceId).waitFor();
            await expect
              .poll(() => disabledReason(unauthorizedIdentity.deviceId))
              .toContain(unauthorizedMessage);
            await capture("02-unauthorized-after-hot-reload.png");
            expect(helloCounts.get(unauthorizedNode)).toBe(unauthorizedHelloCount);
            await page.keyboard.press("Escape");

            await setCommands([COMMAND], []);
            await vi.waitFor(
              async () => {
                await expectState(unauthorizedIdentity, "invocable");
                await expectState(pendingIdentity, "pending-approval", pendingMessage);
              },
              { interval: 250, timeout: 60_000 },
            );
            expect(helloCounts.get(unauthorizedNode)).toBe(unauthorizedHelloCount);
            await page.reload();
            await page.locator("#new-session-where-trigger").click();
            await row(unauthorizedIdentity.deviceId).waitFor();
            expect(await row(unauthorizedIdentity.deviceId).isEnabled()).toBe(true);
            await capture("03-invocable-after-reallow.png");
          },
        );
      } finally {
        await Promise.allSettled(
          clients.toReversed().map((client) => client.stopAndWait({ timeoutMs: 1_000 })),
        );
        const stopped = await gatewayOwner.stop();
        gatewayOwners.splice(gatewayOwners.indexOf(gatewayOwner), 1);
        expect(stopped.errors).toEqual([]);
        expect(existsSync(gateway.tempRoot)).toBe(false);
      }
    },
  );
});

type GatewayHandle = Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>;
type NodeParams = {
  displayName: string;
  gateway: GatewayHandle;
  identity: DeviceIdentity;
  commands: string[];
};

async function connectPairedNode(params: NodeParams & { operator: GatewayClient }) {
  try {
    return await connectClient(params.gateway, params);
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
    await approvePairing(params.operator, params.identity.deviceId, "device");
  }
  let pendingClient: GatewayClient | undefined;
  try {
    pendingClient = await connectClient(params.gateway, params);
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
  }
  await approvePairing(params.operator, params.identity.deviceId, "node");
  await pendingClient?.stopAndWait({ timeoutMs: 1_000 });
  return await connectClient(params.gateway, params);
}

function isPairingRequired(error: unknown): boolean {
  const details =
    error && typeof error === "object"
      ? (error as { details?: { code?: unknown } }).details
      : undefined;
  return details?.code === "PAIRING_REQUIRED" || String(error).includes("pairing required");
}

async function connectClient(gateway: GatewayHandle, node?: Omit<NodeParams, "gateway">) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (client: GatewayClient, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const client = new GatewayClient({
      role: node ? "node" : "operator",
      clientName: node ? GATEWAY_CLIENT_NAMES.NODE_HOST : GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: node?.displayName ?? "Session host picker proof operator",
      mode: node ? GATEWAY_CLIENT_MODES.NODE : GATEWAY_CLIENT_MODES.BACKEND,
      scopes: node ? [] : ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
      deviceIdentity: node?.identity ?? null,
      ...(node ? { deviceFamily: "Linux", caps: ["session.host"], commands: node.commands } : {}),
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      clientVersion: "1.0.0",
      platform: node ? "linux" : process.platform,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onHelloOk: () => {
        helloCounts.set(client, (helloCounts.get(client) ?? 0) + 1);
        finish(client);
      },
      onConnectError: (error) => finish(client, error),
      onClose: (code, reason) => finish(client, new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(client, new Error(`Gateway client connection timed out:\n${gateway.logs()}`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

async function approvePairing(
  operator: GatewayClient,
  nodeId: string,
  kind: "device" | "node",
): Promise<void> {
  let requestId = "";
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ deviceId?: string; nodeId?: string; requestId?: string; role?: string }>;
      }>(`${kind}.pair.list`, {});
      requestId =
        result.pending?.find((entry) =>
          kind === "device"
            ? entry.deviceId === nodeId || entry.role === "node"
            : entry.nodeId === nodeId,
        )?.requestId ?? "";
      expect(requestId).not.toBe("");
    },
    { interval: 100, timeout: REQUEST_TIMEOUT_MS },
  );
  await operator.request(`${kind}.pair.approve`, { requestId });
}

async function waitForPendingCommand(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ commands?: string[]; nodeId?: string }>;
      }>("node.pair.list", {});
      expect(result.pending?.find((entry) => entry.nodeId === nodeId)?.commands).toContain(COMMAND);
    },
    { interval: 100, timeout: REQUEST_TIMEOUT_MS },
  );
}

async function publishSessionHost(node: GatewayClient): Promise<void> {
  await node.request("node.runnerInventory.update", {
    protocolFeatures: ["node-worker-supervisor-v6"],
    workerHost: {
      enabled: true,
      environmentSession: 1,
      capacity: { total: 1, available: 1 },
    },
  });
}

function createDeviceIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    deviceId: crypto.createHash("sha256").update(publicKeyRaw).digest("hex"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
  };
}
