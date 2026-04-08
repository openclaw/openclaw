import assert from "node:assert/strict";
/**
 * Tests for Step 6 — video render pure logic.
 *
 * Network/binary-bound code (Pexels HTTP, ffmpeg, LTX-Video, whisper-cli)
 * is exercised by the live `--stage video` verification step. Here we lock
 * the URL builder, file picker, search-term builder, and whisper.cpp JSON
 * parser.
 *
 * Run with: `npm test`
 */
import { describe, it } from "node:test";
import type { Article, SelectedConcept, SlideContent } from "../../types.js";
import { buildSearchTerm } from "./broll.js";
import { buildSearchUrl, pickBestFile, type PexelsVideoFile } from "./pexels.js";
import { parseWhisperJson } from "./subtitles.js";

function makeFile(
  width: number,
  height: number,
  quality = "hd",
  file_type = "video/mp4",
): PexelsVideoFile {
  return {
    id: width * height,
    quality,
    file_type,
    width,
    height,
    link: `https://example.com/${width}x${height}.mp4`,
  };
}

function makeSlide(title: string): SlideContent {
  return {
    slideType: "story",
    title,
    body: "",
    speakerNotes: "notes",
  };
}

function makeConcept(keywords: string[]): SelectedConcept {
  const seed: Article = {
    title: "seed",
    url: "https://example.com/0",
    source: "Src",
    summary: "summary",
    score: 100,
    published: new Date(),
  };
  return {
    title: "test concept",
    theme: "test theme",
    keywords,
    seedArticle: seed,
    scored: [],
  };
}

describe("buildSearchUrl", () => {
  it("builds the basic Pexels search URL with defaults", () => {
    const url = buildSearchUrl("iran hackers");
    assert.match(url, /api\.pexels\.com\/videos\/search/);
    assert.match(url, /query=iran\+hackers/);
    assert.match(url, /per_page=15/);
  });

  it("includes orientation when provided", () => {
    const url = buildSearchUrl("data center", { orientation: "landscape" });
    assert.match(url, /orientation=landscape/);
  });

  it("includes size hint when provided", () => {
    const url = buildSearchUrl("ai", { size: "medium" });
    assert.match(url, /size=medium/);
  });

  it("respects custom perPage", () => {
    const url = buildSearchUrl("ai", { perPage: 5 });
    assert.match(url, /per_page=5/);
  });

  it("trims whitespace from query", () => {
    const url = buildSearchUrl("  hackers  ");
    assert.match(url, /query=hackers/);
    assert.doesNotMatch(url, /query=\+\+hackers/);
  });
});

describe("pickBestFile", () => {
  it("returns undefined for empty input", () => {
    assert.equal(pickBestFile([]), undefined);
  });

  it("prefers an exact 1920x1080 mp4 match", () => {
    const files = [makeFile(1280, 720, "hd"), makeFile(1920, 1080, "hd"), makeFile(640, 360, "sd")];
    const out = pickBestFile(files);
    assert.equal(out?.width, 1920);
    assert.equal(out?.height, 1080);
  });

  it("falls back to closest-area HD MP4 when no exact match", () => {
    const files = [makeFile(640, 360, "sd"), makeFile(1280, 720, "hd"), makeFile(3840, 2160, "hd")];
    const out = pickBestFile(files, 1920, 1080);
    // 1280x720 area = 921600 (target diff 1152000)
    // 3840x2160 area = 8294400 (target diff 6220800)
    assert.equal(out?.width, 1280);
  });

  it("falls back to first MP4 when no HD available", () => {
    const files = [makeFile(640, 360, "sd")];
    const out = pickBestFile(files);
    assert.equal(out?.width, 640);
  });

  it("respects custom target dimensions", () => {
    const files = [makeFile(1080, 1920, "hd"), makeFile(1920, 1080, "hd")];
    const out = pickBestFile(files, 1080, 1920);
    assert.equal(out?.width, 1080);
    assert.equal(out?.height, 1920);
  });
});

describe("buildSearchTerm", () => {
  it("uses concept keywords when available", () => {
    const concept = makeConcept(["iran", "hackers", "infrastructure"]);
    const term = buildSearchTerm(makeSlide("What Happened"), 0, concept);
    assert.equal(term, "iran");
  });

  it("rotates keywords across slide indices", () => {
    const concept = makeConcept(["iran", "hackers", "infra"]);
    assert.equal(buildSearchTerm(makeSlide("a"), 0, concept), "iran");
    assert.equal(buildSearchTerm(makeSlide("b"), 1, concept), "hackers");
    assert.equal(buildSearchTerm(makeSlide("c"), 2, concept), "infra");
    assert.equal(buildSearchTerm(makeSlide("d"), 3, concept), "iran");
  });

  it("falls back to slide title token when no concept", () => {
    const term = buildSearchTerm(makeSlide("Quantum Computing News"), 0);
    assert.equal(term, "quantum");
  });

  it("skips short tokens and stopwords from title", () => {
    const term = buildSearchTerm(makeSlide("The AI Revolution"), 0);
    // "the" is a stopword (and < 4 chars), "ai" is < 4 chars → "revolution"
    assert.equal(term, "revolution");
  });

  it("returns 'technology' as ultimate fallback when title is empty", () => {
    const term = buildSearchTerm(makeSlide(""), 0);
    assert.equal(term, "technology");
  });
});

describe("parseWhisperJson", () => {
  it("parses token-level transcription into WordTimestamp[]", () => {
    const json = JSON.stringify({
      transcription: [
        {
          tokens: [
            { text: "Hello", offsets: { from: 0, to: 500 } },
            { text: "world", offsets: { from: 500, to: 1000 } },
          ],
        },
      ],
    });
    const out = parseWhisperJson(json);
    assert.equal(out.length, 2);
    assert.equal(out[0].word, "Hello");
    assert.equal(out[0].start, 0);
    assert.equal(out[0].end, 0.5);
    assert.equal(out[1].word, "world");
    assert.equal(out[1].start, 0.5);
    assert.equal(out[1].end, 1.0);
  });

  it("skips internal whisper tokens like [_BEG_]", () => {
    const json = JSON.stringify({
      transcription: [
        {
          tokens: [
            { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
            { text: "Real", offsets: { from: 100, to: 400 } },
            { text: "[_TT_]", offsets: { from: 400, to: 400 } },
          ],
        },
      ],
    });
    const out = parseWhisperJson(json);
    assert.equal(out.length, 1);
    assert.equal(out[0].word, "Real");
  });

  it("falls back to segment-level when no tokens", () => {
    const json = JSON.stringify({
      transcription: [
        {
          text: "two words",
          offsets: { from: 0, to: 2000 },
        },
      ],
    });
    const out = parseWhisperJson(json);
    assert.equal(out.length, 2);
    assert.equal(out[0].word, "two");
    assert.equal(out[1].word, "words");
    // Spread evenly: 1s each
    assert.equal(out[0].start, 0);
    assert.equal(out[0].end, 1);
    assert.equal(out[1].start, 1);
    assert.equal(out[1].end, 2);
  });

  it("returns empty array on malformed JSON", () => {
    assert.deepEqual(parseWhisperJson("not json"), []);
    assert.deepEqual(parseWhisperJson("{broken"), []);
  });

  it("returns empty array when transcription field is missing", () => {
    assert.deepEqual(parseWhisperJson("{}"), []);
  });
});
