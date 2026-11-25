import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";

function chunkStream(text: string, delta: number, minChars = 800, maxChars = 1200): string[] {
  const chunker = new EmbeddedBlockChunker({ minChars, maxChars });
  const chunks: string[] = [];
  const emit = (chunk: string) => chunks.push(chunk);
  for (let start = 0; start < text.length; start += delta) {
    chunker.append(text.slice(start, start + delta));
    chunker.drain({ force: false, emit });
  }
  chunker.drain({ force: true, emit });
  return chunks;
}

const balanced = (chunk: string, tag: string) =>
  (chunk.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length ===
  (chunk.match(new RegExp(`</${tag}>`, "g")) ?? []).length;

const intro =
  "Primorsky grew fastest this year (+50%), Gold followed (+24%), while the main site shrank by 12%.";
const table = [
  "| Location | 2025 | 2026 to date | Forecast | Change |",
  "|---|---|---|---|---|",
  ...Array.from(
    { length: 9 },
    (_, i) => `| Location number ${i} | ${300 + i} | ${280 + i} | ≈${310 + i} | +${i}% |`,
  ),
].join("\n");
const items = Array.from(
  { length: 7 },
  (_, i) =>
    `<li>Location number ${i}: technical ${400 + i} / ${330 + i} / ${371 + i}, warranty ${14 + i} / ${11 + i} / ${19 + i}</li>`,
).join("");
const details = `<details><summary>By department: 2025 / 2026 to date / forecast</summary>\n<ul>${items}</ul>\n</details>`;
const outro =
  "<ul><li><b>Body shop</b> work is all booked on one site.</li><li><b>Warranty</b> is falling at one location.</li></ul>\nForecast: January to August actuals plus a share-weighted remainder.";
// Shaped like a real Telegram rich reply: the island starts before minChars and
// closes just past maxChars, so the only breaks in range sit inside it.
const reply = `${intro}\n\n${table}\n\n${details}\n\n${outro}`;

describe("EmbeddedBlockChunker HTML islands", () => {
  it.each([1, 25, reply.length])(
    "keeps a fitting <details> island in one chunk (delta %i)",
    (delta) => {
      expect(reply.indexOf("<details>")).toBeLessThan(800);
      expect(reply.indexOf("</details>")).toBeGreaterThan(1200);
      const chunks = chunkStream(reply, delta);
      expect(chunks.join("").replace(/\s+/g, "")).toBe(reply.replace(/\s+/g, ""));
      for (const chunk of chunks) {
        expect(balanced(chunk, "details")).toBe(true);
        expect(balanced(chunk, "ul")).toBe(true);
      }
      expect(chunks.some((chunk) => chunk.includes(details))).toBe(true);
    },
  );

  it("keeps paragraph flushes out of an island with blank lines", () => {
    const spaced =
      "Intro line.\n\n<details><summary>Notes</summary>\n\nFirst body paragraph.\n\nSecond body paragraph.\n</details>\n\nDone.";
    const chunker = new EmbeddedBlockChunker({
      minChars: 5,
      maxChars: 1200,
      flushOnParagraph: true,
    });
    const chunks: string[] = [];
    const emit = (chunk: string) => chunks.push(chunk);
    for (let start = 0; start < spaced.length; start += 7) {
      chunker.append(spaced.slice(start, start + 7));
      chunker.drain({ force: false, emit });
    }
    chunker.drain({ force: true, emit });
    expect(chunks.join("").replace(/\s+/g, "")).toBe(spaced.replace(/\s+/g, ""));
    for (const chunk of chunks) {
      expect(balanced(chunk, "details")).toBe(true);
    }
  });

  it("still splits islands that cannot fit in maxChars", () => {
    const longItems = Array.from({ length: 60 }, (_, i) => `<li>Row ${i} with some text</li>`).join(
      "\n",
    );
    const huge = `<details><summary>Big</summary>\n<ul>\n${longItems}\n</ul>\n</details>`;
    const chunks = chunkStream(huge, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
    expect(chunks.join("").replace(/\s+/g, "")).toBe(huge.replace(/\s+/g, ""));
  });

  it("ignores tags inside fenced code and inline code", () => {
    const prose = Array.from({ length: 6 }, () => intro).join(" ");
    const fenced = `${prose}\n\n\`\`\`html\n<details>\n\`\`\`\n\n${prose}\n\nUse \`<details>\` for folds.\n\n${prose}\n\n${prose}`;
    const chunks = chunkStream(fenced, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").replace(/\s+/g, "")).toBe(fenced.replace(/\s+/g, ""));
  });
});
