import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

/** Deterministic geometry proof; phase stills do not prove temporal smoothness. */
export async function captureEngineIdleAnimationPhases(
  page: Page,
  outputDirectory: string,
  prefix: string,
) {
  await mkdir(outputDirectory, { recursive: true });
  const state = await page.evaluateHandle(() => {
    const saved = document.getAnimations().map((animation) => ({
      animation,
      currentTime: animation.currentTime,
      playState: animation.playState,
    }));
    return { saved };
  });
  const captures = [];
  try {
    await state.evaluate(async ({ saved }) => {
      for (const { animation } of saved) {
        animation.pause();
      }
      await Promise.all(saved.map(({ animation }) => animation.ready));
    });
    for (const phase of [0, 0.125, 0.25, 0.5, 0.75]) {
      const metadata = await state.evaluate(({ saved }, progress) => {
        const selector = ".session-glyph__ring, .session-glyph__trace-run";
        for (const { animation, playState } of saved) {
          const effect = animation.effect;
          if (
            playState === "running" &&
            effect instanceof KeyframeEffect &&
            effect.target?.matches(selector)
          ) {
            const duration = Number(effect.getComputedTiming().duration);
            if (Number.isFinite(duration) && duration > 0) {
              animation.currentTime = duration * progress;
            }
          }
        }
        const rectangle = (rect: DOMRect) => ({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
        const indicators = [...document.querySelectorAll(selector)].flatMap((element) => {
          const rect = element.getBoundingClientRect();
          const root = element.closest(".sidebar-shell__body")?.getBoundingClientRect();
          const left = Math.max(0, root?.left ?? 0, rect.left);
          const top = Math.max(0, root?.top ?? 0, rect.top);
          const right = Math.min(innerWidth, root?.right ?? innerWidth, rect.right);
          const bottom = Math.min(innerHeight, root?.bottom ?? innerHeight, rect.bottom);
          const style = getComputedStyle(element);
          if (
            right <= left ||
            bottom <= top ||
            style.visibility !== "visible" ||
            style.display === "none"
          ) {
            return [];
          }
          return [
            {
              classes: element.getAttribute("class"),
              glyph: rectangle(element.closest(".session-glyph")!.getBoundingClientRect()),
              indicator: rectangle(rect),
              clip: { x: left, y: top, width: right - left, height: bottom - top },
              style: Object.fromEntries(
                [
                  "mask-image",
                  "color",
                  "animation-duration",
                  "animation-name",
                  "animation-timing-function",
                  "transform",
                  "rotate",
                  "opacity",
                ].map((name) => [name, style.getPropertyValue(name)]),
              ),
            },
          ];
        });
        return {
          phase: progress,
          viewport: { width: innerWidth, height: innerHeight },
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          indicators,
        };
      }, phase);
      const file = `${prefix}-phase-${String(phase).replace(".", "_")}.png`;
      await page.screenshot({ path: join(outputDirectory, file), scale: "css" });
      captures.push({ file, ...metadata });
    }
  } finally {
    try {
      await state.evaluate(({ saved }) => {
        for (const { animation, currentTime, playState } of saved) {
          animation.currentTime = currentTime;
          if (playState === "running") {
            animation.play();
          } else if (playState === "finished") {
            animation.finish();
          } else if (playState === "idle") {
            animation.cancel();
          } else {
            animation.pause();
          }
        }
      });
    } finally {
      await state.dispose();
    }
  }
  const result = { note: "Phase stills prove geometry only, not unchanged motion.", captures };
  await writeFile(
    join(outputDirectory, `${prefix}-phases.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
