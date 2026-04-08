/**
 * Prompt optimizer — converts slide content into cinematic video generation prompts
 * using the existing LLM pipeline (Ollama/Gemini/etc).
 */

import { generateTextWithFallback, parseModelSpec, generateText } from "../../content/llm.js";
import type { SlideContent, PipelineConfig } from "../../types.js";

const SYSTEM_PROMPT = `You are a cinematic video prompt engineer. Convert the given slide content into a short, vivid video generation prompt (1-2 sentences max).

Rules:
- Describe a visual SCENE, not text or words
- Include camera movement (aerial, tracking, close-up, pan)
- Include lighting and mood (cinematic, neon, golden hour, dramatic)
- Include visual elements that represent the topic abstractly
- Do NOT include any text, titles, or words in the scene
- Do NOT use quotes or narration
- Keep it under 50 words
- Output ONLY the prompt, nothing else

Examples:
- Topic "AI Gets Smarter" → "Sweeping aerial shot of a futuristic data center at dusk, holographic neural networks pulsing with blue light above server racks, cinematic depth of field"
- Topic "Open Source Growth" → "Time-lapse of a digital forest growing from circuit board soil, branches forming code symbols, warm golden light filtering through, macro lens"
- Topic "Startup Funding" → "Slow tracking shot through a modern glass office, screens displaying rising charts, city skyline visible through floor-to-ceiling windows, blue hour lighting"`;

export async function optimizePrompts(
  slides: SlideContent[],
  config: PipelineConfig["content"],
): Promise<string[]> {
  const models = [config.model, ...(config.fallbackModels ?? [])];
  const prompts: string[] = [];

  for (const slide of slides) {
    // Intro/outro slides get generic cinematic prompts
    if (slide.slideType === "intro") {
      prompts.push(
        "Cinematic aerial establishing shot of a futuristic city skyline at dawn, digital particles rising into the sky, warm golden light, 4K",
      );
      continue;
    }
    if (slide.slideType === "outro") {
      prompts.push(
        "Slow zoom out from a glowing digital globe, network connections pulsing across continents, transitioning to a starfield, cinematic lighting",
      );
      continue;
    }

    const slideContext = [
      `Title: ${slide.title}`,
      `Content: ${Array.isArray(slide.body) ? slide.body.join(", ") : slide.body}`,
      slide.speakerNotes ? `Narration: ${slide.speakerNotes.slice(0, 200)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const result = await generateTextWithFallback(models, {
        system: SYSTEM_PROMPT,
        prompt: slideContext,
      });
      prompts.push(result.trim());
    } catch {
      // Fallback: generate a generic tech prompt from the title
      prompts.push(
        `Cinematic slow-motion shot related to ${slide.title}, futuristic technology aesthetic, dramatic lighting, shallow depth of field, 4K`,
      );
    }
  }

  return prompts;
}

/** Generate a single optimized prompt without fallback chain (for testing) */
export async function optimizeSinglePrompt(slide: SlideContent, model: string): Promise<string> {
  const config = parseModelSpec(model);
  const slideContext = `Title: ${slide.title}\nContent: ${Array.isArray(slide.body) ? slide.body.join(", ") : slide.body}`;
  const result = await generateText(config, {
    system: SYSTEM_PROMPT,
    prompt: slideContext,
  });
  return result.trim();
}
