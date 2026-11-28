/** Change hints arrive once per vault change, and agents change the vault in
 * bursts. Every refresh reads through the store's single lane, where it delays
 * the operator's own navigation. Coalesce hints into one trailing refresh per
 * quiet period (never postponed past `maxWaitMs`). While the view is paused
 * (document hidden or the host not presenting it), remember the hint instead;
 * `resume()` and becoming visible run one refresh if any hint was missed. */
export function coalesceChanges(
  refresh: () => void,
  presented: () => boolean,
  { quietMs = 750, maxWaitMs = 3000 } = {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined,
    first = 0,
    missed = false;
  const active = () => !document.hidden && presented();
  const run = () => {
    timer = undefined;
    first = 0;
    refresh();
  };
  const resume = () => {
    if (active() && missed) {
      missed = false;
      run();
    }
  };
  document.addEventListener("visibilitychange", resume);
  return {
    /** True when a periodic resync may read now. */
    active,
    changed: () => {
      if (!active()) {
        clearTimeout(timer);
        timer = undefined;
        first = 0;
        missed = true;
        return;
      }
      const now = Date.now();
      first ||= now;
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (active()) {
            run();
          } else {
            timer = undefined;
            first = 0;
            missed = true;
          }
        },
        Math.max(0, Math.min(quietMs, first + maxWaitMs - now)),
      );
    },
    resume,
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", resume);
    },
  };
}
