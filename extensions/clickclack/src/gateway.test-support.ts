import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { vi } from "vitest";
import type { ResolvedClickClackAccount } from "./types.js";

export type GatewayContext = ChannelGatewayContext<ResolvedClickClackAccount>;

export function createGatewayContext(
  abortSignal: AbortSignal,
  transport: { apiBaseUrl: string; reconnectMs: number; commandMenu?: boolean },
): GatewayContext {
  return {
    cfg: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          token: "test-token",
          workspace: "main",
          ...transport,
        },
      },
    } as GatewayContext["cfg"],
    accountId: "default",
    account: {} as ResolvedClickClackAccount,
    runtime: {} as GatewayContext["runtime"],
    abortSignal,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => ({ accountId: "default" }) as ReturnType<GatewayContext["getStatus"]>,
    setStatus: vi.fn(),
  };
}
