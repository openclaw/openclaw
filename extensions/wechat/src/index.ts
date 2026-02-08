import type {
    ClawdbotPluginApi,
    ChannelPlugin,
    ChannelDock,
    ClawdbotConfig,
    PluginRuntime,
    MarkdownTableMode
} from 'clawdbot/plugin-sdk';
import {
    emptyPluginConfigSchema,
    buildChannelConfigSchema,
    normalizeAccountId,
    DEFAULT_ACCOUNT_ID
} from 'clawdbot/plugin-sdk';
import axios from 'axios';
import { IncomingMessage, ServerResponse } from 'http';
import { setRuntime, getRuntime } from './runtime.js';
import { z } from 'zod';

// --- Types ---

interface WeChatConfig {
    authToken?: string;
    callbackUrl?: string; // Optional default callback URL
    allowFrom?: string[];
    dmPolicy?: 'open' | 'pairing' | 'disabled';
}

interface WebhookPayload {
    task: string;
    callback_url?: string; // The bridge might send this
    metadata?: {
        openid?: string;
        msg_type?: string;
        msg_id?: string;
        timestamp?: number;
        nickname?: string;
        [key: string]: unknown;
    };
}

// --- Runtime Helper ---

type CoreRuntime = PluginRuntime;

// --- Webhook Handler ---

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

// Global map to store callback URLs for sessions if needed, 
// though we prefer to pass it through the pipeline via context or assume configuration.
// For this refactor, we'll try to extract it from the context during delivery.

async function handleWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // Only handle POST /webhook (or configured path)
    // The bridge might send to /, so we check method.
    if (req.method !== 'POST') return false;

    // Simple path check - in a real plugin we might want configurable paths
    if (req.url && !req.url.endsWith('/webhook') && req.url !== '/') return false;

    try {
        const body = await readJsonBody(req) as WebhookPayload;

        // Basic Validation
        if (!body.task) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Missing task' }));
            return true;
        }

        // We accept the request immediately
        res.statusCode = 202;
        res.end(JSON.stringify({ status: 'accepted' }));

        // Process in background
        processMessageWithPipeline(body).catch(err => {
            console.error('Pipeline processing error:', err);
        });

        return true;
    } catch (err) {
        console.error('Webhook handler error:', err);
        res.statusCode = 500;
        res.end('Internal Server Error');
        return true;
    }
}

// --- Pipeline ---

async function processMessageWithPipeline(payload: WebhookPayload) {
    const core = getRuntime();
    // Assuming single-tenant/default account for now as per original code
    // In a full implementation, we'd resolve the account based on the request (e.g. auth token)
    const accountId = DEFAULT_ACCOUNT_ID;

    // We need access to the config. 
    // Since we don't have the full config object passed in, we might need to fetch it from runtime or similar.
    // However, `dispatchReplyWithBufferedBlockDispatcher` takes `cfg`.
    // In the Zalo example, `processUpdate` receives `config`.
    // Here, we'll assume we can get the global config or pass a minimal one.
    // For now, we'll try to read it from the core if possible or construct a placeholder.
    // NOTE: In the original code, `pluginApi.config` was available. 
    // In the new SDK structure, we should be careful. 
    // `core.config` might not be directly exposed.
    // BUT! `api.registerChannel` passes `cfg` to methods. `handleWebhookRequest` is outside that flow.
    // We strictly need the config. 
    // WORKAROUND: We will store the latest config in a global variable when the plugin is loaded/reloaded.

    const config = _globalConfig || {};

    const senderId = payload.metadata?.openid || 'unknown_user';
    const senderName = payload.metadata?.nickname || `User ${senderId.slice(0, 4)}`;
    const text = payload.task;
    const chatId = senderId; // For DM, chat ID is usually user ID

    // Construct IDs
    const fromLabel = `wechat:${senderId}`;

    // Authorization / Pairing Logic
    // Simplified: Check allowFrom list
    // In a full implementation, follow Zalo's `isSenderAllowed` and `pairing` logic

    // Ensure config is not null
    const safeConfig = config || {};

    const route = core.channel.routing?.resolveAgentRoute?.({
        cfg: safeConfig,
        channel: 'wechat',
        accountId: accountId,
        peer: { kind: 'dm', id: chatId }
    }) || {
        // Fallback if routing fails (e.g. config not updated)
        agentId: (safeConfig as any)?.plugins?.entries?.['webhook-server']?.config?.agentId || 'default',
        accountId: accountId,
        sessionKey: `wechat:${senderId}`
    };

    if (!route) {
        // Should not happen with fallback, but TS check
        console.error('Failed to resolve agent route');
        return;
    }

    const sessionKey = route.sessionKey || `wechat:${senderId}`;

    // Construct Context
    // We need to pass the callback_url through to the delivery phase.
    // We can use the 'Ctx' fields or `Originating...` fields if they allow custom data,
    // or rely on `InboundContext` having flexible fields.
    const callbackUrl = payload.callback_url;

    // Get Store Path (using config.session?.store if available)
    // We try to access config.session from the global config
    const storePath = core.channel.session?.resolveStorePath?.((safeConfig as any).session?.store, { agentId: route.agentId });

    // Format Envelope
    const envelopeOptions = core.channel.reply?.resolveEnvelopeFormatOptions?.(safeConfig);
    const previousTimestamp = core.channel.session?.readSessionUpdatedAt?.({
        storePath,
        sessionKey
    });

    const timestamp = payload.metadata?.timestamp ? payload.metadata.timestamp * 1000 : Date.now();

    const formattedBody = core.channel.reply?.formatAgentEnvelope?.({
        channel: 'WeChat',
        from: senderName, // User friendly name
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: text
    }) || text; // Fallback to raw text if formatter missing

    const ctxPayload = core.channel.reply?.finalizeInboundContext?.({
        Body: formattedBody,
        RawBody: text,
        From: `wechat:${senderId}`,
        To: `wechat:bot`,
        SessionKey: sessionKey,
        AccountId: accountId,
        AgentId: route.agentId || accountId, // Fix: Explicitly pass AgentId
        ChatType: 'direct',
        ConversationLabel: senderName,
        SenderName: senderName,
        SenderId: senderId,
        Provider: 'wechat',
        Surface: 'wechat',
        // Pass callback_url here so we can retrieve it in deliver
        _CallbackUrl: callbackUrl,
    });

    if (!ctxPayload) return;

    // Record Session
    await core.channel.session?.recordInboundSession?.({
        storePath,
        sessionKey,
        ctx: ctxPayload
    });

    // Dispatch
    await core.channel.reply?.dispatchReplyWithBufferedBlockDispatcher?.({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
            deliver: async (deliverPayload: { text?: string }) => {
                await deliverWeChatReply({
                    text: deliverPayload.text,
                    callbackUrl: callbackUrl || (_globalConfig?.channels?.wechat?.config?.callbackUrl),
                    originalPayload: payload
                });
            },
            onError: (err: unknown, info: { kind: string }) => {
                console.error(`WeChat dispatch error (${info.kind}):`, err);
            }
        }
    });
}

// --- Delivery ---

async function deliverWeChatReply(params: {
    text?: string;
    callbackUrl?: string;
    originalPayload: WebhookPayload
}) {
    const { text, callbackUrl } = params;
    if (!text || !callbackUrl) return;

    try {
        await axios.post(callbackUrl, {
            success: true,
            result: text,
            // Add metadata if needed by Bridge
            metadata: {
                // model: ... (Not easily available in this callback without extra context)
            }
        });
    } catch (error) {
        console.error(`Failed to deliver reply to ${callbackUrl}:`, error);
    }
}

// --- Plugin Definition ---

let _globalConfig: ClawdbotConfig | null = null;

const wechatPlugin: ChannelPlugin<any> = {
    id: 'wechat',
    meta: {
        id: 'wechat',
        label: 'WeChat',
        selectionLabel: 'WeChat (Bridge)',
        description: 'WeChat integration via Bridge Webhook',
        docsPath: '',
    },
    configSchema: buildChannelConfigSchema(
        z.object({
            callbackUrl: z.string().optional().describe('URL to send replies to (e.g. Bridge URL)'),
        }).extend({
            accounts: z.object({}).catchall(z.object({
                callbackUrl: z.string().optional(),
            })).optional(),
            defaultAccount: z.string().optional()
        })
    ),
    capabilities: {
        chatTypes: ['direct'], // Webhook acts like DM usually
        media: false, // Set to true if supported
        blockStreaming: true, // We prefer full blocks for webhook callbacks mostly
    },
    // Implement other required methods (minimal implementation)
    // ...
    config: {
        // Minimal config helpers
        listAccountIds: () => [DEFAULT_ACCOUNT_ID],
        resolveAccount: (cfg: any) => ({
            accountId: DEFAULT_ACCOUNT_ID,
            name: 'Default',
            enabled: true,
            config: cfg?.plugins?.entries?.['webhook-server']?.config || {} // Fallback to old config location or new one?
            // Ideally we move config to `channels.wechat`
        }),
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        isConfigured: () => true, // Always considered configured for now
        describeAccount: () => ({ accountId: DEFAULT_ACCOUNT_ID, name: 'Default', enabled: true, configured: true }),
    },
    // We wrap 'reload' to capture config
    reload: {
        configPrefixes: ['channels.wechat', 'plugins.entries.webhook-server']
    }
};

const wechatDock: ChannelDock = {
    id: 'wechat',
    capabilities: {
        chatTypes: ['direct'],
        media: false,
        blockStreaming: true
    },
    config: {
        // Helpers for UI
        resolveAllowFrom: () => [],
        formatAllowFrom: () => []
    }
};

// Main Export
export default {
    id: 'wechat',
    name: 'WeChat',
    description: 'WeChat Channel Plugin',
    configSchema: emptyPluginConfigSchema(),

    register(api: ClawdbotPluginApi) {
        setRuntime(api.runtime);
        _globalConfig = api.config;

        // Register as a channel
        api.registerChannel({
            plugin: wechatPlugin,
            dock: wechatDock
        });

        // Register the HTTP handler for webhooks
        // Note: The 'webhook-server' service is no longer needed in this pattern
        // as registerHttpHandler hooks into the main server.
        api.registerHttpHandler(handleWebhookRequest);

        // Keep a listener for config changes if API supports it, 
        // or just rely on the fact that `api.config` is a reference 
        // (though usually it's a snapshot at register time). 
        // Ideally we implement the `reload` capability in the plugin definition.

        api.logger.info('WeChat Webhook Channel registered');
    }
};
