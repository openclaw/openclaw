import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractMarkdownToolCalls } from "./ollama-stream.js";

type ReplayFixture = {
  name: string;
  content: string;
  allowedTools: string[];
  expectedToolCalls: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
};

const fixturePath = resolve(process.cwd(), "test/fixtures/ollama-markdown-toolcall-replay.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as ReplayFixture[];

describe("ollama markdown tool-call replay fixtures", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(extractMarkdownToolCalls(fixture.content, new Set(fixture.allowedTools))).toEqual(
        fixture.expectedToolCalls,
      );
    });
  }
});
