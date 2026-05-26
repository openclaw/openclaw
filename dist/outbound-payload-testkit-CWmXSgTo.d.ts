import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { r as ReplyPayload } from "./reply-payload-BlNiejVc.js";
import { t as DispatchFromConfigResult } from "./dispatch-from-config.types-D9GatrrF.js";
import { t as ChannelTurnDispatchResultLike } from "./dispatch-result-CBhc_yqr.js";
import { Mock } from "vitest";

//#region src/channels/plugins/contracts/test-helpers.d.ts
declare function primeChannelOutboundSendMock<TArgs extends unknown[]>(sendMock: Mock<(...args: TArgs) => Promise<unknown>>, fallbackResult: Record<string, unknown>, sendResults?: Record<string, unknown>[]): void;
declare function expectChannelInboundContextContract(ctx: MsgContext): void;
declare function expectChannelTurnDispatchResultContract(result: ChannelTurnDispatchResultLike, expected: {
  visible: boolean;
  final?: boolean;
  counts?: Partial<DispatchFromConfigResult["counts"]>;
}): void;
//#endregion
//#region src/channels/plugins/contracts/inbound-testkit.d.ts
declare function buildDispatchInboundCaptureMock<T extends Record<string, unknown>>(actual: T, setCtx: (ctx: unknown) => void): T & {
  dispatchInboundMessage: import("vitest").Mock<(params: {
    ctx: unknown;
  }) => Promise<{
    queuedFinal: boolean;
    counts: {
      tool: number;
      block: number;
      final: number;
    };
  }>>;
  dispatchInboundMessageWithDispatcher: import("vitest").Mock<(params: {
    ctx: unknown;
  }) => Promise<{
    queuedFinal: boolean;
    counts: {
      tool: number;
      block: number;
      final: number;
    };
  }>>;
  dispatchInboundMessageWithBufferedDispatcher: import("vitest").Mock<(params: {
    ctx: unknown;
  }) => Promise<{
    queuedFinal: boolean;
    counts: {
      tool: number;
      block: number;
      final: number;
    };
  }>>;
};
//#endregion
//#region src/channels/plugins/contracts/outbound-payload-testkit.d.ts
type PayloadLike = Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "text">;
type SendResultLike = {
  messageId: string;
  [key: string]: unknown;
};
type ChunkingMode = {
  longTextLength: number;
  maxChunkLength: number;
  mode: "split";
} | {
  longTextLength: number;
  mode: "passthrough";
};
type OutboundPayloadHarness = {
  run: () => Promise<Record<string, unknown>>;
  sendMock: Mock;
  to: string;
};
type OutboundPayloadHarnessParams = {
  payload: PayloadLike;
  sendResults?: SendResultLike[];
};
declare function installChannelOutboundPayloadContractSuite(params: {
  channel: string;
  chunking: ChunkingMode;
  createHarness: (params: OutboundPayloadHarnessParams) => OutboundPayloadHarness | Promise<OutboundPayloadHarness>;
}): void;
//#endregion
export { expectChannelTurnDispatchResultContract as a, expectChannelInboundContextContract as i, installChannelOutboundPayloadContractSuite as n, primeChannelOutboundSendMock as o, buildDispatchInboundCaptureMock as r, OutboundPayloadHarnessParams as t };