/** One host-requested utterance, completed by audible output rather than model receipts. */
export function createRealtimeHostSpeechController(params: {
  interrupt: () => void;
  trigger: (instructions: string) => void;
}) {
  let closed = false;
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: Error) => {
    const current = pending;
    pending = undefined;
    clearTimeout(quietTimer);
    clearTimeout(deadline);
    if (error) {
      current?.reject(error);
    } else {
      current?.resolve();
    }
  };
  return {
    isActive: () => Boolean(pending),
    speak(instructions: string): Promise<void> {
      if (closed) {
        return Promise.reject(new Error("Realtime bridge is closed"));
      }
      finish(new Error("Host speech replaced"));
      return new Promise<void>((resolve, reject) => {
        try {
          params.interrupt();
          if (closed) {
            throw new Error("Realtime bridge is closed");
          }
          pending = { resolve, reject };
          deadline = setTimeout(
            () => finish(new Error("Realtime speech did not finish within 45 seconds")),
            45_000,
          );
          deadline.unref?.();
          params.trigger(instructions);
        } catch (error) {
          const rejection = error instanceof Error ? error : new Error(String(error));
          finish(rejection);
          reject(rejection);
        }
      });
    },
    noteAudibleOutput() {
      if (!pending) {
        return;
      }
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), 1_500);
      quietTimer.unref?.();
    },
    close() {
      closed = true;
      finish(new Error("Realtime bridge closed during host speech"));
    },
  };
}
