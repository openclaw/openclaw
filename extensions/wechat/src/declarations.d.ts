declare module 'clawdbot/plugin-sdk' {
    export interface ClawdbotPluginApi {
        logger: {
            info: (msg: string, ...args: unknown[]) => void;
            warn: (msg: string, ...args: unknown[]) => void;
            error: (msg: string, ...args: unknown[]) => void;
            debug: (msg: string, ...args: unknown[]) => void;
        };
        config: ClawdbotConfig;
        registerChannel: (options: { plugin: ChannelPlugin<any>; dock: ChannelDock }) => void;
        registerHttpHandler: (handler: (req: any, res: any) => Promise<boolean> | boolean) => void;
        runtime: PluginRuntime;
        [key: string]: unknown;
    }

    export interface ClawdbotConfig {
        plugins?: {
            entries?: Record<string, { config?: any }>;
        };
        channels?: Record<string, any>;
        [key: string]: unknown;
    }

    export interface PluginRuntime {
        channel: {
            routing?: {
                resolveAgentRoute?: (params: any) => { sessionKey: string; agentId?: string; accountId?: string };
            };
            reply?: {
                resolveEnvelopeFormatOptions?: (cfg: any) => any;
                formatAgentEnvelope?: (params: any) => string;
                finalizeInboundContext?: (params: any) => any;
                dispatchReplyWithBufferedBlockDispatcher?: (params: {
                    ctx: any;
                    cfg: any;
                    dispatcherOptions: {
                        deliver: (payload: { text?: string }) => Promise<void>;
                        onError: (err: unknown, info: { kind: string }) => void;
                    };
                }) => Promise<void>;
            };
            session?: {
                readSessionUpdatedAt?: (params: any) => number | undefined;
                resolveStorePath?: (store: any, params: { agentId?: string }) => string;
                recordInboundSession?: (params: any) => Promise<void>;
            };
            [key: string]: unknown;
        };
        [key: string]: unknown;
    }

    export interface ChannelPlugin<T> {
        id: string;
        meta: any;
        configSchema: any;
        capabilities: any;
        config: any;
        reload?: any;
        [key: string]: unknown;
    }

    export interface ChannelDock {
        id: string;
        capabilities: any;
        config: any;
        [key: string]: unknown;
    }

    export type MarkdownTableMode = 'code' | 'text' | 'image';

    export const emptyPluginConfigSchema: () => any;
    export const buildChannelConfigSchema: (schema: any) => any;
    export const normalizeAccountId: (id: string | undefined) => string;
    export const DEFAULT_ACCOUNT_ID: string;
}
