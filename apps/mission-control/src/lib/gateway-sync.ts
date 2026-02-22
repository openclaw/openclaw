/**
 * Gateway Sync — pushes API key changes from SQLite to the OpenClaw gateway
 * via the configPatch() RPC method.
 *
 * All operations are non-fatal: if the gateway is unreachable, changes are
 * saved locally and the UI shows a "gateway sync pending" status.
 */
import { getOpenClawClient } from "@/lib/openclaw-client";

export interface GatewaySyncResult {
    synced: boolean;
    error?: string;
}

/**
 * Push an API key to the gateway's provider configuration.
 */
export async function syncKeyToGateway(
    provider: string,
    apiKey: string,
    baseUrl?: string | null
): Promise<GatewaySyncResult> {
    try {
        const client = getOpenClawClient();
        await client.connect();

        const providerConfig: Record<string, unknown> = { apiKey };
        if (baseUrl) {
            providerConfig.baseUrl = baseUrl;
        }

        await client.configPatch({
            providers: {
                [provider]: providerConfig,
            },
        });

        return { synced: true };
    } catch (err) {
        console.warn("[gateway-sync] Push failed (non-fatal):", provider, String(err));
        return { synced: false, error: String(err) };
    }
}

/**
 * Remove an API key from the gateway's provider configuration.
 */
export async function removeKeyFromGateway(
    provider: string
): Promise<GatewaySyncResult> {
    try {
        const client = getOpenClawClient();
        await client.connect();

        await client.configPatch({
            providers: {
                [provider]: null,
            },
        });

        return { synced: true };
    } catch (err) {
        console.warn("[gateway-sync] Remove failed (non-fatal):", provider, String(err));
        return { synced: false, error: String(err) };
    }
}

/**
 * Check if the gateway is reachable.
 */
export async function isGatewayReachable(): Promise<boolean> {
    try {
        const client = getOpenClawClient();
        await client.connect();
        return client.isConnected();
    } catch {
        return false;
    }
}
