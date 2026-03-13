import matter from "gray-matter";
import { OpenAI } from "openai";

/**
 * 輔助函數：帶有隨機抖動 (Jitter) 的休眠
 */
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms + Math.random() * 1000));

/**
 * 高級遮罩系統
 */
export function maskBatchParagraphs(paragraphs: string[]): {
  maskedBatch: string;
  blocksMap: Map<string, string>;
} {
  const blocksMap = new Map<string, string>();
  const maskedParagraphs: string[] = [];

  paragraphs.forEach((p, pIdx) => {
    let blockIndex = 0;
    let inlineIndex = 0;
    const blockRegex = /```[\s\S]*?```/g;
    let masked = p.replace(blockRegex, (match) => {
      const placeholder = `[[P${pIdx}_B_${blockIndex}]]`;
      blocksMap.set(placeholder, match);
      blockIndex++;
      return placeholder;
    });
    const inlineRegex = /`([^`\n]+)`/g;
    masked = masked.replace(inlineRegex, (match) => {
      const placeholder = `[[P${pIdx}_I_${inlineIndex}]]`;
      blocksMap.set(placeholder, match);
      inlineIndex++;
      return placeholder;
    });
    maskedParagraphs.push(masked);
  });

  return { maskedBatch: maskedParagraphs.join("\n\n---BATCH_SEP---\n\n"), blocksMap };
}

/**
 * 還原批次內容
 */
export function unmaskBatchContent(
  translatedBatch: string,
  blocksMap: Map<string, string>,
): string[] {
  let cleaned = translatedBatch.replace(/`/g, "");
  const pParts = cleaned.split(/---BATCH_SEP---/i).map((p) => p.trim());
  return pParts.map((p) => {
    let restored = p;
    const sortedPlaceholders = Array.from(blocksMap.keys()).toSorted((a, b) => b.length - a.length);
    for (const placeholder of sortedPlaceholders) {
      restored = restored.split(placeholder).join(blocksMap.get(placeholder));
    }
    return restored;
  });
}

export function splitIntoParagraphs(content: string): string[] {
  const parsed = matter(content);
  return parsed.content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function extractCodeBlocks(content: string): string[] {
  const codeBlocks: string[] = [];
  const blockRegex = /```[\s\S]*?```/g;
  const inlineRegex = /`([^`\n]+)`/g;
  const blocks = content.match(blockRegex) || [];
  codeBlocks.push(...blocks.map((b) => b.trim()));
  const withoutBlocks = content.replace(blockRegex, "");
  let match;
  while ((match = inlineRegex.exec(withoutBlocks)) !== null) {
    codeBlocks.push(match[0].trim());
  }
  return codeBlocks;
}

export function validateParagraphIntegrity(original: string, translated: string): boolean {
  const normalize = (str: string) =>
    str
      .replace(/\s+/g, "")
      .replace(/["“”]/g, "'")
      .replace(/['‘’]/g, "'")
      .replace(/[….]+/g, "...");
  const sBlocks = extractCodeBlocks(original).map(normalize);
  const tBlocks = extractCodeBlocks(translated).map(normalize);
  if (sBlocks.length !== tBlocks.length) {
    return false;
  }
  const sSorted = [...sBlocks].toSorted();
  const tSorted = [...tBlocks].toSorted();
  for (let i = 0; i < sSorted.length; i++) {
    if (!sSorted[i].includes("mermaid") && sSorted[i] !== tSorted[i]) {
      return false;
    }
  }
  return true;
}

/**
 * 工業級翻譯引擎
 */
export async function translateBatch(
  apiKey: string,
  systemPrompt: string,
  maskedBatch: string,
  model: string,
  retryCount = 0,
): Promise<string> {
  const openai = new OpenAI({ apiKey });
  const sanitizedContent = maskedBatch.normalize("NFC");
  const estimatedOutputTokens = Math.ceil(sanitizedContent.length * 2);

  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: sanitizedContent },
      ],
      temperature: 0,
      max_completion_tokens: Math.min(estimatedOutputTokens, 4000),
    });

    return response.choices[0].message.content || "";
  } catch (err: unknown) {
    const error = err as { status?: number };
    if ((error.status === 429 || (error.status && error.status >= 500)) && retryCount < 5) {
      const waitTime = Math.pow(2, retryCount) * 2000;
      console.log(
        `\n⚠️ [API 限制/錯誤] 狀態碼: ${error.status}。將於 ${waitTime / 1000} 秒後重試...`,
      );
      await sleep(waitTime);
      return translateBatch(apiKey, systemPrompt, maskedBatch, model, retryCount + 1);
    }
    if (error.status === 400 && retryCount < 2) {
      await sleep(1000);
      return translateBatch(apiKey, systemPrompt, maskedBatch, model, retryCount + 1);
    }
    throw err;
  }
}
