import type { DeviceCredentials } from "../db/queries.js";
import { createGatewayWsClient } from "./client.js";
import { buildDeviceAuthPayload, signDevicePayload } from "./device-auth.js";

export type ConfigPatchOptions = {
  gatewayUrl: string;
  gatewayToken: string;
  device: DeviceCredentials;
  botToken: string;
  signingSecret: string;
};

export async function patchGatewayConfig(opts: ConfigPatchOptions): Promise<void> {
  const client = createGatewayWsClient({ url: opts.gatewayUrl });

  try {
    await client.waitOpen();

    // Wait for the gateway's connect.challenge event containing the nonce
    const challenge = await client.waitForEvent("connect.challenge");
    const nonce = (challenge as { payload?: { nonce?: string } }).payload?.nonce;
    if (!nonce) {
      throw new Error("Gateway did not send a connect nonce");
    }

    const role = "operator";
    const scopes = ["operator.admin", "operator.read", "operator.write"];
    const signedAtMs = Date.now();

    // Build and sign the device auth payload (v2 with nonce)
    const payload = buildDeviceAuthPayload({
      deviceId: opts.device.deviceId,
      clientId: "gateway-client",
      clientMode: "backend",
      role,
      scopes,
      signedAtMs,
      token: opts.gatewayToken,
      nonce,
    });
    const signature = signDevicePayload(opts.device.privateKeyPem, payload);

    const connectRes = await client.request("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "gateway-client", version: "1.0.0", platform: "docker", mode: "backend" },
      role,
      scopes,
      auth: { token: opts.gatewayToken },
      device: {
        id: opts.device.deviceId,
        publicKey: opts.device.publicKeyBase64Url,
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    });

    if (!connectRes.ok) {
      throw new Error(`Gateway connect failed: ${JSON.stringify(connectRes.error)}`);
    }

    // Get current config to obtain baseHash
    const getRes = await client.request("config.get", {});
    if (!getRes.ok) {
      throw new Error(`config.get failed: ${JSON.stringify(getRes.error)}`);
    }

    const configPayload = getRes.payload as { hash?: string } | undefined;
    const baseHash = configPayload?.hash;
    if (!baseHash) {
      throw new Error("config.get response missing hash");
    }

    // Build the config patch — always HTTP mode for hub-managed Slack
    const patch = {
      channels: {
        slack: {
          enabled: true,
          mode: "http",
          botToken: opts.botToken,
          signingSecret: opts.signingSecret,
          webhookPath: "/slack/events",
        },
      },
    };

    // Attempt config.patch, retry once on stale hash
    let patchRes = await client.request("config.patch", {
      raw: JSON.stringify(patch),
      baseHash,
    });

    if (!patchRes.ok) {
      const errMsg =
        typeof patchRes.error === "object" && patchRes.error !== null
          ? ((patchRes.error as { message?: string }).message ?? "")
          : String(
              patchRes.error !== null && patchRes.error !== undefined
                ? JSON.stringify(patchRes.error)
                : "",
            );

      if (errMsg.includes("config changed since last load") || errMsg.includes("stale")) {
        const retryGet = await client.request("config.get", {});
        if (!retryGet.ok) {
          throw new Error(`config.get retry failed: ${JSON.stringify(retryGet.error)}`);
        }
        const retryHash = (retryGet.payload as { hash?: string } | undefined)?.hash;
        if (!retryHash) {
          throw new Error("config.get retry missing hash");
        }

        patchRes = await client.request("config.patch", {
          raw: JSON.stringify(patch),
          baseHash: retryHash,
        });
      }

      if (!patchRes.ok) {
        throw new Error(`config.patch failed: ${JSON.stringify(patchRes.error)}`);
      }
    }
  } finally {
    client.close();
  }
}
