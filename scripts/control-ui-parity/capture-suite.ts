import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../ui/src/test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { fingerprintFixtures } from "./fixture-fingerprint.ts";
import { hash, writeGallery, type Capture } from "./report.ts";
import { baseScenario, fixedTime, profiles, scenes } from "./scenarios.ts";

const options: { output?: string; scene?: string; profile?: string; css?: string } = JSON.parse(
  process.env.OPENCLAW_PARITY_OPTIONS ?? "{}",
);
const selectedScenes = scenes.filter(
  (scene) => !options.scene || new RegExp(options.scene, "u").test(scene.id),
);
const selectedProfiles = profiles.filter(
  (profile) => !options.profile || new RegExp(options.profile, "u").test(profile.id),
);
if (!selectedScenes.length || !selectedProfiles.length) {
  throw new Error("Parity selection matches no scenes or profiles");
}
const suite = createControlUiE2eSuite({
  name: "Control UI visual parity",
  startServerBeforeBrowser: true,
  browserLaunchOptions: {
    // Apply static animation changes before the compositor samples the frame.
    args: [
      "--enable-features=CDPScreenshotNewSurface",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--disable-threaded-animation",
      "--run-all-compositor-stages-before-draw",
    ],
  },
});
const captureOrigin = "http://parity.localhost:18789";
let directory: string;
let stylesheet: string | undefined;
let capture: Capture;
suite.define(() => {
  beforeAll(async () => {
    directory = createControlUiE2eArtifactDir("parity", options.output);
    stylesheet = options.css ? await readFile(options.css, "utf8") : undefined;
    const contract = {
      expectedShots: selectedProfiles.flatMap((profile) =>
        selectedScenes.map((scene) => `${scene.id}--${profile.id}`),
      ),
      fixtures: hash(
        JSON.stringify({
          fixedTime,
          resolvedFixtures: fingerprintFixtures(
            [baseScenario, ...selectedScenes.map((scene) => scene.scenario ?? {})],
            execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
          ),
          profiles: selectedProfiles,
          scenes: selectedScenes.map((scene) => scene.id),
          // Hash the recipe source, not absolute fixture paths, so two worktrees compare.
          recipes: await Promise.all(
            [
              "capture-suite.ts",
              "scenarios.ts",
              "fixtures.ts",
              "fixture-fingerprint.ts",
              "../../ui/src/test-helpers/control-ui-e2e-screenshot.ts",
            ].map(async (file) => hash(await readFile(new URL(file, import.meta.url)))),
          ),
        }),
      ),
    };
    capture = {
      version: 1,
      source: {
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean),
      },
      browser: suite.browser.version(),
      platform: `${process.platform}-${process.arch}`,
      catalog: hash(JSON.stringify(contract)),
      contract,
      options: { ...options, css: stylesheet ? hash(stylesheet) : undefined },
      shots: [],
      failures: [],
      complete: false,
    };
    await writeGallery(directory, capture);
  });
  afterAll(async () => {
    if (!capture) {
      return;
    }
    capture.complete =
      capture.failures.length === 0 &&
      capture.shots.length === selectedScenes.length * selectedProfiles.length;
    await writeGallery(directory, capture);
    console.log(
      `[control-ui-parity] ${capture.shots.length} shots, ${capture.failures.length} failures: ${directory}`,
    );
  });
  for (const profile of selectedProfiles) {
    for (const scene of selectedScenes) {
      const id = `${scene.id}--${profile.id}`;
      it(
        id,
        async () => {
          try {
            await suite.withPage(
              {
                viewport: { width: profile.width, height: profile.height },
                colorScheme: profile.theme,
                locale: "en-US",
                timezoneId: "UTC",
                serviceWorkers: "block",
                deviceScaleFactor: 1,
                forcedColors: profile.forced ? "active" : "none",
                reducedMotion: profile.reduced ? "reduce" : "no-preference",
              },
              async ({ page }) => {
                const pageErrors: string[] = [];
                page.on("pageerror", (error) => pageErrors.push(error.message));
                await page.route("**/*", async (route) => {
                  const url = new URL(route.request().url());
                  if (url.origin !== captureOrigin) {
                    await route.abort();
                    return;
                  }
                  // The visible connection URL must not inherit the server's random port.
                  const response = await route.fetch({
                    url: new URL(`${url.pathname}${url.search}`, suite.server.baseUrl).href,
                  });
                  if (response.headers()["content-type"]?.includes("image/svg+xml")) {
                    const body = await page.evaluate(
                      (source) => {
                        const document = new DOMParser().parseFromString(source, "image/svg+xml");
                        // SVG image timelines are isolated from the page's Web Animations API.
                        // Removing only SMIL instructions samples the asset's base presentation.
                        for (const animation of document.querySelectorAll(
                          "animate, animateMotion, animateTransform, set",
                        )) {
                          animation.remove();
                        }
                        return new XMLSerializer().serializeToString(document);
                      },
                      await response.text(),
                    );
                    await route.fulfill({ response, body });
                  } else {
                    await route.fulfill({ response });
                  }
                });
                await page.clock.setFixedTime(fixedTime);
                await page.addInitScript(() => {
                  // A fixed draw keeps module-level decorative salts independent of load order.
                  Math.random = () => 0.42;
                  // Keep native frame delivery for readiness, but sample JS animation time
                  // independently of network and renderer speed (including canvas mascots).
                  let frameTime = 0;
                  Object.defineProperty(performance, "now", { value: () => frameTime });
                  const requestFrame = window.requestAnimationFrame.bind(window);
                  window.requestAnimationFrame = (callback) =>
                    requestFrame(() => callback(frameTime));
                  window.addEventListener("parity-frame-time", (event) => {
                    frameTime = (event as CustomEvent<number>).detail;
                  });
                });
                const gateway = await installMockGateway(page, {
                  ...baseScenario,
                  ...scene.scenario,
                  methodResponses: {
                    ...baseScenario.methodResponses,
                    ...scene.scenario?.methodResponses,
                  },
                });
                await page.goto(new URL(scene.path, captureOrigin).href);
                if (scene.route) {
                  await waitForControlUiRoute(page, { routeId: scene.route });
                }
                const content = page.locator(scene.ready).first();
                await content.waitFor();
                await page.evaluate(({ rtl, scale }) => {
                  if (rtl) {
                    document.documentElement.dir = "rtl";
                  }
                  if (scale) {
                    document.documentElement.style.fontSize = `${16 * scale}px`;
                  }
                }, profile);
                if (stylesheet) {
                  await page.addStyleTag({ content: stylesheet });
                }
                await scene.prepare?.(page, gateway);
                if (scene.route === "new-session") {
                  await page.evaluate(() => {
                    // Finish the typed New Session placeholder at a fixed animation sample.
                    window.dispatchEvent(new CustomEvent("parity-frame-time", { detail: 3_000 }));
                  });
                }
                if (!scene.loading) {
                  await expect
                    .poll(() =>
                      page
                        .locator(
                          ".settings-loading-skeleton:visible, openclaw-panel-loading-skeleton:visible",
                        )
                        .count(),
                    )
                    .toBe(0);
                }
                expect(pageErrors, "Synthetic scene must render without uncaught errors").toEqual(
                  [],
                );
                // The invitation is never part of visual evidence, even after fixture changes.
                expect(await page.locator(".community-invite").count()).toBe(0);
                const frame = await takeControlUiScreenshotFrame(
                  page,
                  page.locator("openclaw-app"),
                  [content],
                  {
                    animations: "disabled",
                    animationFrameBeforeCapture: true,
                    ...(scene.scrollTo ? { scrollTo: page.locator(scene.scrollTo) } : {}),
                  },
                );
                const file = `${id}.png`;
                await writeFile(path.join(directory, file), frame.png);
                capture.shots.push({
                  id,
                  scene: scene.id,
                  profile: profile.id,
                  label: `${scene.label} / ${profile.id}`,
                  file,
                  sha256: hash(frame.png),
                  width: profile.width,
                  height: profile.height,
                });
              },
            );
          } catch (error) {
            capture.failures.push({
              id,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            await writeGallery(directory, capture);
          }
        },
        90_000,
      );
    }
  }
  it("keeps gallery feedback across reload and exports the labeled example", async () => {
    await suite.withPage(
      { permissions: ["clipboard-read", "clipboard-write"] },
      async ({ page }) => {
        const shot = capture.shots[0]!;
        await page.goto(pathToFileURL(path.join(directory, "index.html")).href);
        const feedback = page.locator(`textarea[data-id="${shot.id}"]`);
        await feedback.fill("Review spacing beside this control.");
        await page.reload();
        expect(await feedback.inputValue()).toBe("Review spacing beside this control.");
        await page.getByRole("button", { name: "Copy feedback", exact: true }).click();
        await expect.poll(() => page.locator("#copy-result").textContent()).toBe("Copied");
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toBe(`## ${shot.id}\n${shot.label}\nReview spacing beside this control.`);
        await feedback.fill("");
      },
    );
  });
});
