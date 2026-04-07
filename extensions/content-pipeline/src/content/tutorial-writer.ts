import type { VideoContent, PipelineConfig } from "../types.js";
import { generateTextWithFallback, stripCodeFences } from "./llm.js";

const SYSTEM_PROMPT = `You are a tech tutorial video script writer. You create clear, educational scripts for tutorial videos (5-10 minutes).

Rules:
- Break the topic into logical progressive steps
- Each step builds on the previous one
- Include working code examples (not pseudocode)
- Narration should explain WHY, not just WHAT
- Use simple, clear language suitable for text-to-speech
- For code slides, keep snippets short (under 15 lines)
- Avoid special characters that TTS might mispronounce
- Do NOT use markdown formatting in speaker notes`;

function buildPrompt(topic: string, tone: string, language: string): string {
  return `Create a tutorial video script about: "${topic}". Tone: ${tone}. Language: ${language}.

Respond in this exact JSON format (no markdown fences):
{
  "videoTitle": "short catchy title for the tutorial",
  "videoDescription": "YouTube description explaining what viewers will learn, 2-3 sentences",
  "tags": ["tag1", "tag2", "tag3"],
  "slides": [
    {
      "slideType": "title",
      "title": "Tutorial Topic",
      "body": "What you'll learn (3-4 bullet points)",
      "speakerNotes": "Welcome intro narration (2-3 sentences)"
    },
    {
      "slideType": "step",
      "title": "Step 1: Step Name",
      "body": "Explanation text with key points",
      "speakerNotes": "Narration explaining this step (3-4 sentences)"
    },
    {
      "slideType": "code",
      "title": "Code Example",
      "body": "Brief description of what this code does",
      "code": "const example = 'actual working code';",
      "language": "typescript",
      "speakerNotes": "Narration walking through the code (3-4 sentences)"
    },
    {
      "slideType": "outro",
      "title": "Recap & Next Steps",
      "body": "Key takeaways and what to explore next",
      "speakerNotes": "Closing narration (2-3 sentences)"
    }
  ]
}`;
}

export async function generateTutorialScript(
  topic: string,
  config: PipelineConfig["content"],
): Promise<VideoContent> {
  const models = [config.model, ...(config.fallbackModels ?? [])];
  console.log(`🤖 Stage 2: Generating tutorial script (${models.length} models in chain)...`);

  const prompt = buildPrompt(topic, config.tone, config.language);
  const raw = await generateTextWithFallback(models, { system: SYSTEM_PROMPT, prompt });
  const cleaned = stripCodeFences(raw);

  const data = JSON.parse(cleaned) as VideoContent;

  console.log(`  ✓ Script: "${data.videoTitle}"`);
  console.log(`  ✓ ${data.slides.length} slides\n`);

  return data;
}
