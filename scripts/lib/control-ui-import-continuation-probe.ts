// Opt-in benchmark instrumentation; callback timings include synchronous descendants only.
export function importContinuationProbe() {
  if (window !== window.top) {
    return;
  }
  const samples: unknown[] = [];
  Reflect.set(window, "__importContinuations", samples);
  const originalThen = Promise.prototype.then;
  Promise.prototype.then = function (fulfilled, rejected) {
    const wrap = (callback: typeof fulfilled) => {
      if (typeof callback !== "function") {
        return callback;
      }
      return function (this: unknown, value: unknown) {
        const start = performance.now();
        try {
          return Reflect.apply(callback, this, [value]);
        } finally {
          const duration = performance.now() - start;
          const module =
            value !== null &&
            typeof value === "object" &&
            Reflect.get(value, Symbol.toStringTag) === "Module";
          if (module || duration >= 2) {
            samples.push({
              kind: "then",
              start,
              duration,
              exports: module ? Object.keys(value) : undefined,
              callback: Function.prototype.toString.call(callback).slice(0, 600),
            });
          }
        }
      };
    };
    return Reflect.apply(originalThen, this, [wrap(fulfilled), wrap(rejected)]);
  };
  const define = customElements.define;
  customElements.define = function (name, constructor, options) {
    for (const method of ["connectedCallback", "disconnectedCallback"] as const) {
      const callback = Reflect.get(constructor.prototype, method);
      if (typeof callback !== "function") {
        continue;
      }
      Reflect.set(constructor.prototype, method, function (this: HTMLElement) {
        const start = performance.now();
        try {
          return Reflect.apply(callback, this, []);
        } finally {
          samples.push({ kind: method, name, start, duration: performance.now() - start });
        }
      });
    }
    const start = performance.now();
    try {
      return Reflect.apply(define, this, [name, constructor, options]);
    } finally {
      samples.push({ kind: "define", name, start, duration: performance.now() - start });
    }
  };
}
