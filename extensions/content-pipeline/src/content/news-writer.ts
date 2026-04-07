import type { Article, VideoContent, PipelineConfig } from "../types.js";
import { generateTextWithFallback, stripCodeFences } from "./llm.js";

const SYSTEM_PROMPT = `You are a tech news video script writer. You create engaging, concise scripts for short-form tech news videos (3-5 minutes).

Rules:
- Keep each story segment to 3-4 sentences of narration
- Use simple, clear language suitable for text-to-speech
- Make it conversational and energetic
- Include a hook intro and a brief outro
- For slide body text, use short bullet points (max 3 per slide)
- Avoid special characters that TTS might mispronounce
- Do NOT use markdown formatting in speaker notes`;

function buildPrompt(articles: Article[], topN: number, tone: string, language: string): string {
  const list = articles
    .slice(0, topN)
    .map(
      (a, i) => `
${i + 1}. **${a.title}**
   Source: ${a.source}
   URL: ${a.url}
   Summary: ${a.summary}`,
    )
    .join("\n");

  return `Create a tech news video script from these top ${topN} stories. Tone: ${tone}. Language: ${language}.

Articles:
${list}

Respond in this exact JSON format (no markdown fences):
{
  "videoTitle": "short catchy title for the video",
  "videoDescription": "YouTube description with key topics, 2-3 sentences",
  "tags": ["tag1", "tag2", "tag3"],
  "slides": [
    {
      "slideType": "intro",
      "title": "Today in Tech",
      "body": "3 bullet points previewing top stories",
      "speakerNotes": "Narration for the intro slide (2-3 sentences)"
    },
    {
      "slideType": "story",
      "title": "Short headline for slide",
      "body": "2-3 bullet points summarizing the story",
      "sourceUrl": "article URL",
      "speakerNotes": "Narration for this story (3-4 sentences)"
    },
    {
      "slideType": "outro",
      "title": "That's a Wrap!",
      "body": "Call to action bullet points",
      "speakerNotes": "Outro narration (1-2 sentences)"
    }
  ]
}`;
}

export async function generateNewsScript(
  articles: Article[],
  config: PipelineConfig["content"],
): Promise<VideoContent> {
  const models = [config.model, ...(config.fallbackModels ?? [])];
  console.log(`🤖 Stage 2: Generating content (${models.length} models in chain)...`);

  const prompt = buildPrompt(articles, config.topStories, config.tone, config.language);
  const raw = await generateTextWithFallback(models, { system: SYSTEM_PROMPT, prompt });
  const cleaned = stripCodeFences(raw);

  const data = JSON.parse(cleaned) as VideoContent;

  console.log(`  ✓ Script: "${data.videoTitle}"`);
  console.log(`  ✓ ${data.slides.length} slides\n`);

  return data;
}
