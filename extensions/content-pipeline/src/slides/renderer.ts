import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import { chromium, type Browser } from "playwright";
import type { VideoContent, SlideContent, PipelineConfig } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "templates");

// Configure nunjucks
const env = nunjucks.configure(TEMPLATES_DIR, { autoescape: true });

const TEMPLATE_MAP: Record<string, string> = {
  intro: "news-intro.html",
  story: "news-story.html",
  outro: "news-outro.html",
  title: "tutorial-title.html",
  step: "tutorial-step.html",
  code: "tutorial-code.html",
};

function getTemplateData(slide: SlideContent, index: number, total: number) {
  // Handle body as string or array (LLMs sometimes return arrays)
  const bodyStr = Array.isArray(slide.body)
    ? (slide.body as string[]).join("\n")
    : String(slide.body ?? "");
  const bodyLines = bodyStr
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);

  const stepMatch = slide.title.match(/step\s*(\d+)/i);
  const stepNumber = stepMatch ? parseInt(stepMatch[1], 10) : index;

  return {
    title: slide.title,
    body: slide.body,
    body_lines: bodyLines,
    sourceUrl: slide.sourceUrl ?? "",
    source: slide.sourceUrl ? new URL(slide.sourceUrl).hostname.replace("www.", "") : "",
    code: slide.code ?? "",
    language: slide.language ?? "",
    date: new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    slideIndex: index + 1,
    totalSlides: total,
    stepNumber,
  };
}

export async function renderSlides(
  content: VideoContent,
  outputDir: string,
  config: PipelineConfig["slides"],
): Promise<string[]> {
  console.log("🎨 Stage 3: Rendering slides...");

  const slidesDir = join(outputDir, "slides");
  await mkdir(slidesDir, { recursive: true });

  let browser: Browser | undefined;
  const paths: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: config.width, height: config.height });

    for (let i = 0; i < content.slides.length; i++) {
      const slide = content.slides[i];
      const templateFile = TEMPLATE_MAP[slide.slideType] ?? "news-story.html";
      const data = getTemplateData(slide, i, content.slides.length);

      const html = env.render(templateFile, data);

      // Load HTML with base URL for CSS
      await page.setContent(html, { waitUntil: "networkidle" });

      // Wait for fonts to load
      await page.waitForTimeout(500);

      const outputPath = join(slidesDir, `slide_${String(i + 1).padStart(2, "0")}.png`);
      await page.screenshot({ path: outputPath, type: "png" });
      paths.push(outputPath);
    }

    console.log(`  ✓ ${paths.length}/${content.slides.length} slides rendered\n`);
  } finally {
    await browser?.close();
  }

  return paths;
}
