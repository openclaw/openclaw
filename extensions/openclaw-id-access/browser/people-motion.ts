import { onSettled } from "solid-js";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Presentation only: measure existing groups around a committed UI change. */
export function createPeopleMotion() {
  const groups = new Set<HTMLElement>();
  const watchContent = new Set<HTMLElement>();
  const requests = new Map<string, HTMLElement>();
  const running = new Map<HTMLElement, () => void>();
  const exits = new Map<HTMLElement, Promise<void>>();
  let prepared = new Map<HTMLElement, number>();

  const group = (options: { requestKey?: () => string; watchContent?: boolean } = {}) => {
    let element: HTMLElement;
    onSettled(() => {
      // A request row is keyed by invite ID for this DOM lifetime.
      const requestId = options.requestKey?.();
      groups.add(element);
      if (options.watchContent) {
        watchContent.add(element);
      }
      if (requestId) {
        requests.set(requestId, element);
      }
      return () => {
        running.get(element)?.();
        groups.delete(element);
        watchContent.delete(element);
        exits.delete(element);
        if (requestId && requests.get(requestId) === element) {
          requests.delete(requestId);
        }
      };
    });
    return (node: HTMLElement) => {
      element = node;
    };
  };

  const prepare = () => {
    const before = new Map<HTMLElement, number>();
    for (const element of groups) {
      if (!element.isConnected || exits.has(element)) {
        continue;
      }
      before.set(element, element.getBoundingClientRect().height);
    }
    for (const element of before.keys()) {
      running.get(element)?.();
    }
    prepared = before;
    return () => {
      if (reducedMotion()) {
        return;
      }
      // Measure every natural end height before constraining nested groups.
      const after = [...before]
        .filter(([element]) => element.isConnected)
        .map(([element, height]) => ({
          element,
          height,
          next: element.getBoundingClientRect().height,
        }));
      for (const { element, height, next } of after) {
        if (Math.abs(next - height) < 1) {
          continue;
        }
        element.style.height = `${height}px`;
        element.style.overflow = "hidden";
        element.style.alignContent = "start";
        element.getBoundingClientRect();
        element.style.transition = "height .28s cubic-bezier(.2,.8,.2,1)";
        element.style.height = `${next}px`;
        // The host picker mounts asynchronously. Its natural content can grow
        // after Solid settles, so retarget an active invite morph on that resize.
        let observer: ResizeObserver | undefined;
        if (watchContent.has(element)) {
          const sizes = new Map(
            [...element.children].map((child) => [child, child.getBoundingClientRect().height]),
          );
          observer = new ResizeObserver(() => {
            if (
              [...sizes].some(
                ([child, size]) => Math.abs(child.getBoundingClientRect().height - size) >= 1,
              )
            ) {
              prepare()();
            }
          });
          for (const child of sizes.keys()) {
            observer.observe(child);
          }
        }
        const timer = window.setTimeout(clear, 300);
        function clear() {
          window.clearTimeout(timer);
          observer?.disconnect();
          element.style.height = "";
          element.style.overflow = "";
          element.style.alignContent = "";
          element.style.transition = "";
          running.delete(element);
        }
        running.set(element, clear);
      }
    };
  };

  const enter = () => {
    const before = prepared;
    let element: HTMLElement;
    onSettled(() => {
      // Initial data has no prior groups. A newly visible section already enters as a whole.
      if (
        before.size &&
        ![...before].some(([container, height]) => height < 2 && container.contains(element))
      ) {
        element.classList.add("ocid-access__enter");
      }
    });
    return (node: HTMLElement) => {
      element = node;
    };
  };

  const update = (change: () => void) => {
    const finish = prepare();
    change();
    onSettled(finish);
  };

  const leaveRequests = async (remaining: ReadonlySet<string>) => {
    const pending: Promise<void>[] = [];
    const departing = [...requests].filter(
      ([id, element]) => !remaining.has(id) && !exits.has(element),
    );
    const heights = new Map(
      departing.map(([, element]) => [element, element.getBoundingClientRect().height]),
    );
    // An interrupted disclosure/error morph must not hold an ancestor at its old
    // height while a request collapses underneath it. Preserve the row's current
    // height; its natural ancestors then follow the collapse without a cleanup snap.
    for (const container of groups) {
      if (departing.some(([, element]) => container.contains(element))) {
        running.get(container)?.();
      }
    }
    for (const [id, element] of requests) {
      if (remaining.has(id)) {
        if (exits.has(element)) {
          running.get(element)?.();
          exits.delete(element);
          element.classList.remove("ocid-access__gone");
          element.style.height = "";
        }
        continue;
      }
      let exit = exits.get(element);
      if (!exit && !reducedMotion()) {
        running.get(element)?.();
        element.style.height = `${heights.get(element)}px`;
        element.getBoundingClientRect();
        element.classList.add("ocid-access__gone");
        element.style.height = "0px";
        exit = new Promise<void>((resolve) => {
          const timer = window.setTimeout(finish, 280);
          function finish() {
            window.clearTimeout(timer);
            running.delete(element);
            resolve();
          }
          running.set(element, finish);
        });
        exits.set(element, exit);
      }
      if (exit) {
        pending.push(exit);
      }
    }
    await Promise.all(pending);
  };

  return { group, enter, prepare, update, leaveRequests };
}

export type PeopleMotion = ReturnType<typeof createPeopleMotion>;
