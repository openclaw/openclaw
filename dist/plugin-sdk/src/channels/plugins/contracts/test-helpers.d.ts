import { type Mock } from "vitest";
import type { DispatchFromConfigResult } from "../../../auto-reply/reply/dispatch-from-config.types.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { type ChannelTurnDispatchResultLike } from "../../turn/dispatch-result.js";
export declare function primeChannelOutboundSendMock<TArgs extends unknown[]>(sendMock: Mock<(...args: TArgs) => Promise<unknown>>, fallbackResult: Record<string, unknown>, sendResults?: Record<string, unknown>[]): void;
export declare function expectChannelInboundContextContract(ctx: MsgContext): void;
export declare function expectChannelTurnDispatchResultContract(result: ChannelTurnDispatchResultLike, expected: {
    visible: boolean;
    final?: boolean;
    counts?: Partial<DispatchFromConfigResult["counts"]>;
}): void;
