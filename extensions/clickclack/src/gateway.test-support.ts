import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { vi } from "vitest";
import { resolveClickClackAccount } from "./accounts.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

export type GatewayContext = ChannelGatewayContext<ResolvedClickClackAccount>;

export function createGatewayContext(
  abortSignal: AbortSignal,
  transport: { apiBaseUrl: string; reconnectMs: number; commandMenu?: boolean },
): GatewayContext {
  const cfg: CoreConfig = {
    channels: {
      clickclack: {
        baseUrl: "https://clickclack.example",
        token: "test-token",
        workspace: "main",
        ...transport,
      },
    },
  };
  return {
    cfg,
    accountId: "default",
    account: resolveClickClackAccount({ cfg }),
    runtime: {} as GatewayContext["runtime"],
    abortSignal,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => ({ accountId: "default" }) as ReturnType<GatewayContext["getStatus"]>,
    setStatus: vi.fn(),
  };
}
