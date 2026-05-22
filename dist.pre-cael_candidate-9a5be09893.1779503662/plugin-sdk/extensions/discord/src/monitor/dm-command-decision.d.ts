import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
export declare function handleDiscordDmCommandDecision(params: {
    senderAccess: Pick<ResolvedChannelMessageIngress["senderAccess"], "decision">;
    accountId: string;
    sender: {
        id: string;
        tag?: string;
        name?: string;
    };
    onPairingCreated: (code: string) => Promise<void>;
    onUnauthorized: () => Promise<void>;
    upsertPairingRequest?: typeof upsertChannelPairingRequest;
}): Promise<boolean>;
