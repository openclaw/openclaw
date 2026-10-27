export const hangingFetchUntilAbort: typeof globalThis.fetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const reason = init.signal?.reason;
      reject(reason instanceof Error ? reason : new Error("aborted"));
    });
  });
