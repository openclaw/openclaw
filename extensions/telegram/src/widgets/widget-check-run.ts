import { JSException, MAX_STACK_SIZE, QuickJS, type JSValueHandle } from "quickjs-wasi";
import { TELEGRAM_WIDGET_CHECK_SHIM } from "./widget-check-shim.js";

export type TelegramWidgetCheckInput = {
  source: string;
  /** State the widget starts with: `chatData` on a new widget, or the tapped widget's old state. */
  state: string | null;
  /** For a state update: the state delivered by `chatDataChanged` after the first render. */
  nextState?: string | null;
  /** Simulate a tap on every button and click target (new widgets only). */
  tapAll: boolean;
};

export type TelegramWidgetCheckResult = {
  /** Exact problems Telegram would reject or break; the widget is not sent. */
  errors: string[];
  /** Approximate findings passed back to the model; the widget is still sent. */
  warnings: string[];
  /** The checker itself failed; callers must not block the widget on it. */
  unavailable?: string;
};

// A widget is small UI code; a second covers rendering, 3 s of timers and two dozen taps.
const CHECK_TIME_LIMIT_MS = 1_500;
const CHECK_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

type IntlRequest = { kind: string; locale?: string | string[]; opts?: object; value: unknown };

// Telegram bridges Intl to the client platform; the trial run bridges it to the host's Intl.
function runIntl(json: string): string {
  try {
    // SAFETY: the guest shim builds this JSON; each field is type-checked below before use.
    const { kind, locale, opts, value } = JSON.parse(json) as IntlRequest;
    const options = opts && typeof opts === "object" ? opts : undefined;
    let out: string;
    if (kind === "number") {
      out = new Intl.NumberFormat(locale, options).format(Number(value));
    } else if (kind === "date") {
      out = new Intl.DateTimeFormat(locale, options).format(Number(value));
    } else if (kind === "date-method" && Array.isArray(value)) {
      // SAFETY: the shim sends date-method values as [method name, epoch ms].
      const [method, time] = value as [string, number];
      const date = new Date(time);
      out =
        method === "toLocaleDateString"
          ? date.toLocaleDateString(locale, options)
          : method === "toLocaleTimeString"
            ? date.toLocaleTimeString(locale, options)
            : date.toLocaleString(locale, options);
    } else if (kind === "plural") {
      out = new Intl.PluralRules(locale, options).select(Number(value));
    } else if (kind === "relative" && Array.isArray(value)) {
      out = new Intl.RelativeTimeFormat(locale, options).format(
        Number(value[0]),
        // SAFETY: Intl validates the unit and throws, which is reported back to the guest.
        String(value[1]) as Intl.RelativeTimeFormatUnit,
      );
    } else if (kind === "list" && Array.isArray(value)) {
      // SAFETY: Intl validates the options object and throws on bad values.
      out = new Intl.ListFormat(locale, options as Intl.ListFormatOptions).format(
        value.map(String),
      );
    } else {
      return JSON.stringify({ error: `Unsupported Intl request ${kind}` });
    }
    return JSON.stringify({ value: out });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

/** Runs one widget in a fresh QuickJS heap and returns what Telegram would reject or break. */
export async function runTelegramWidgetCheck(
  input: TelegramWidgetCheckInput,
  wasm: WebAssembly.Module,
): Promise<TelegramWidgetCheckResult> {
  let deadline = performance.now() + CHECK_TIME_LIMIT_MS;
  let interrupted = false;
  let timedOut = false;
  const rejections: string[] = [];
  const vm = await QuickJS.create({
    wasm,
    memoryLimit: CHECK_MEMORY_LIMIT_BYTES,
    maxStackSize: MAX_STACK_SIZE,
    interruptHandler: () => {
      timedOut ||= performance.now() >= deadline;
      return timedOut;
    },
    onUnhandledRejection: (_promise, reason, handled) => {
      // fetch() already reports the missing network; its rejection adds nothing.
      if (!handled && rejections.length < 3) {
        const dumped = vm.dump(reason);
        const text =
          dumped && typeof dumped === "object" && "message" in dumped
            ? String(dumped.message)
            : String(dumped);
        if (!text.includes("not available in widgets")) {
          rejections.push(`Unhandled promise rejection: ${text}`);
        }
      }
    },
  });
  try {
    // SAFETY: the shim only calls __intl with JSON.stringify output, a string.
    vm.newFunction("__intl", (arg) => vm.newString(runIntl(vm.dump(arg) as string))).consume((fn) =>
      vm.global.setProp("__intl", fn),
    );
    vm.newString(input.source).consume((h) => vm.global.setProp("__widgetSource", h));
    (input.state === null ? vm.null : vm.newString(input.state)).consume((h) =>
      vm.global.setProp("__widgetState", h),
    );
    vm.evalCode(TELEGRAM_WIDGET_CHECK_SHIM, "widget-check.js").dispose();
    const driver = vm.global.getProp("__widgetCheck");
    const call = (name: string, ...args: JSValueHandle[]): unknown => {
      const fn = vm.getProp(driver, vm.newString(name));
      try {
        const result = vm.callFunction(fn, driver, ...args);
        const value = vm.dump(result);
        result.dispose();
        return value;
      } finally {
        fn.dispose();
      }
    };
    const recordError = (error: unknown) => {
      if (error instanceof JSException) {
        call("recordError", error.handle);
        error.handle.dispose();
        return;
      }
      throw error;
    };
    try {
      for (;;) {
        const code = call("nextScript");
        if (code === null) {
          break;
        }
        if (typeof code !== "string" || !code.trim()) {
          continue;
        }
        const number = call("scriptNumber");
        try {
          // Each inline script evaluates in global scope, named so stack lines point at it.
          vm.evalCode(code, `script-${String(number)}.js`).dispose();
        } catch (error) {
          if (timedOut) {
            throw error;
          }
          recordError(error);
        }
        vm.executePendingJobs();
      }
      call("loaded");
      vm.executePendingJobs();
      if (input.nextState !== undefined) {
        (input.nextState === null ? vm.null : vm.newString(input.nextState)).consume((h) =>
          call("dataChanged", h),
        );
        vm.executePendingJobs();
      }
      if (input.tapAll) {
        call("tapAll");
        vm.executePendingJobs();
      }
    } catch (error) {
      if (!timedOut) {
        throw error;
      }
      interrupted = true;
    }
    // Findings so far are still valid after an interrupt; give the report its own short budget.
    timedOut = false;
    deadline = performance.now() + 250;
    // SAFETY: the shim's report() returns JSON.stringify({ errors, warnings, unsupported, ... }).
    const report = JSON.parse(String(call("report"))) as {
      errors: string[];
      warnings: string[];
      unsupported: string | null;
    };
    driver.dispose();
    const errors = [...report.errors, ...rejections];
    if (interrupted) {
      errors.push(
        "The widget code did not finish running within a second (an endless loop or very heavy work). Telegram would stop it.",
      );
    }
    if (report.unsupported) {
      // The widget uses a web API the trial run does not model, so its findings are not reliable.
      return { errors: [], warnings: [], unavailable: `uses ${report.unsupported}` };
    }
    return { errors, warnings: report.warnings };
  } catch (error) {
    if (timedOut) {
      return {
        warnings: [],
        errors: [
          "The widget code did not finish running within a second (an endless loop or very heavy work). Telegram would stop it.",
        ],
      };
    }
    return {
      errors: [],
      warnings: [],
      unavailable: error instanceof Error ? error.message : String(error),
    };
  } finally {
    vm.dispose();
  }
}
