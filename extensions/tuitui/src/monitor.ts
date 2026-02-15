import type { ResolvedTuituiAccount } from "./accounts.js";

export type TuituiMonitorOptions = {
  account: ResolvedTuituiAccount;
  abortSignal: AbortSignal;
};

/**
 * 推推当前无长连接/轮询收消息，仅保持 account 为 running 状态以便出站发送。
 * 返回的 Promise 在 abort 时 resolve，便于 gateway 清理。后续可接入 webhook/轮询处理入站。
 */
export function monitorTuituiProvider(options: TuituiMonitorOptions): Promise<void> {
  const { abortSignal } = options;
  return new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}
