// The carrier can report active before its newly enabled media route is audible.
// Give that route one short settling window. Only a real caller transcript may
// cancel the greeting because raw VAD can fire on route noise and never report a
// matching stop event, which would otherwise leave an answered call silent.
const FACETIME_INITIAL_GREETING =
  "Greet the caller briefly, introduce yourself using your configured identity, and ask how you can help.";
const FACETIME_GREETING_MEDIA_SETTLE_MS = 100;

export function createFaceTimeInitialGreeting(params: {
  delayMs?: number;
  speak: (instructions: string) => void;
}): {
  readonly instructions: string;
  schedule(): void;
  cancel(): void;
} {
  let timer: NodeJS.Timeout | undefined;
  let dismissed = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    instructions: FACETIME_INITIAL_GREETING,
    schedule() {
      if (dismissed || timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        dismissed = true;
        params.speak(FACETIME_INITIAL_GREETING);
      }, params.delayMs ?? FACETIME_GREETING_MEDIA_SETTLE_MS);
      timer.unref?.();
    },
    cancel() {
      dismissed = true;
      clear();
    },
  };
}
