import type { Page } from "playwright";
import type { EngineConfiguration } from "./control-ui-engine-configurations.ts";

/** Observe preference arrival without holding the boot path until translations load. */
export async function installEngineConfigurationObserver(
  page: Page,
  configuration: EngineConfiguration,
  app: boolean,
) {
  await page.addInitScript(
    ({ locale, theme, themeMode, app: isApp }) => {
      const resolved =
        theme === "claw"
          ? themeMode
          : `${theme === "knot" ? "openknot" : theme}${themeMode === "light" ? "-light" : ""}`;
      const state = { appliedMs: 0, fontsReadyMs: 0 };
      Reflect.set(window, "__engineConfiguration", state);
      const sample = () => {
        if (
          !isApp ||
          (document.documentElement.lang === locale &&
            document.documentElement.dataset.theme === resolved)
        ) {
          state.appliedMs = performance.now();
        } else {
          requestAnimationFrame(sample);
        }
      };
      requestAnimationFrame(sample);
      window.addEventListener(
        "load",
        () => {
          void document.fonts.ready.then(() => {
            state.fontsReadyMs = performance.now();
          });
        },
        { once: true },
      );
    },
    { ...configuration, app },
  );
}

/** Resource timing and styles are collected after timing; they never fetch extra assets. */
export async function readEngineConfigurationObservation(
  page: Page,
  configuration: EngineConfiguration,
  app: boolean,
) {
  const evidence = await page.evaluate(() => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const body = getComputedStyle(document.body);
    const state: { appliedMs: number; fontsReadyMs: number } = Reflect.get(
      window,
      "__engineConfiguration",
    );
    const resources = performance
      .getEntriesByType("resource")
      .filter(
        (entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming,
      )
      .map((entry) => ({
        path: new URL(entry.name).pathname,
        startMs: entry.startTime,
        endMs: entry.responseEnd,
        encodedBytes: entry.encodedBodySize,
        transferBytes: entry.transferSize,
        initiator: entry.initiatorType,
      }));
    return {
      ...state,
      lang: root.lang,
      dir: root.dir,
      theme: root.dataset.theme,
      themeMode: root.dataset.themeMode,
      deviceScaleFactor: devicePixelRatio,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      forcedColors: matchMedia("(forced-colors: active)").matches,
      fontsStatus: document.fonts.status,
      fonts: [...document.fonts].map(({ family, style, weight, status }) => ({
        family,
        style,
        weight,
        status,
      })),
      computed: {
        color: body.color,
        backgroundColor: body.backgroundColor,
        fontFamily: body.fontFamily,
        fontSize: body.fontSize,
        direction: styles.direction,
      },
      resources,
    };
  });
  const expectedTheme =
    configuration.theme === "claw"
      ? configuration.themeMode
      : `${configuration.theme === "knot" ? "openknot" : configuration.theme}${configuration.themeMode === "light" ? "-light" : ""}`;
  if (
    (app && (evidence.lang !== configuration.locale || evidence.theme !== expectedTheme)) ||
    evidence.deviceScaleFactor !== configuration.deviceScaleFactor
  ) {
    throw new Error(`Configuration did not apply: ${JSON.stringify({ configuration, evidence })}`);
  }
  return evidence;
}
