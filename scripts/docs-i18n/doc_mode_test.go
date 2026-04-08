package main

import (
	"context"
	"strings"
	"testing"
)

type docChunkTranslator struct{}

func (docChunkTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (docChunkTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	switch {
	case strings.Contains(text, "Alpha block") && strings.Contains(text, "Beta block"):
		return strings.ReplaceAll(text, "</Accordion>", ""), nil
	default:
		replacer := strings.NewReplacer(
			"Alpha block", "阿尔法段",
			"Beta block", "贝塔段",
			"Code sample", "代码示例",
		)
		return replacer.Replace(text), nil
	}
}

func (docChunkTranslator) Close() {}

func TestParseTaggedDocumentRejectsMissingBodyCloseAtEOF(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n"

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for missing </body>")
	}
}

func TestParseTaggedDocumentRejectsTrailingTextOutsideTags(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n</body>\nextra"

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for trailing text")
	}
}

func TestSplitDocBodyIntoBlocksKeepsFenceTogether(t *testing.T) {
	t.Parallel()

	body := strings.Join([]string{
		"<Accordion title=\"Alpha block\">",
		"",
		"Code sample:",
		"```ts",
		"console.log('hello')",
		"```",
		"",
		"Beta block",
		"",
		"</Accordion>",
		"",
	}, "\n")

	blocks := splitDocBodyIntoBlocks(body)
	if len(blocks) != 4 {
		t.Fatalf("expected 4 blocks, got %d", len(blocks))
	}
	if !strings.Contains(blocks[1], "```ts") || !strings.Contains(blocks[1], "```") {
		t.Fatalf("expected code fence to stay in a single block:\n%s", blocks[1])
	}
	if !strings.Contains(blocks[2], "Beta block") {
		t.Fatalf("expected Beta paragraph in its own block:\n%s", blocks[2])
	}
}

func TestTranslateDocBodyChunkedFallsBackToSmallerChunks(t *testing.T) {
	body := strings.Join([]string{
		"<Accordion title=\"Alpha block\">",
		"Alpha block",
		"</Accordion>",
		"",
		"Beta block",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	translated, err := translateDocBodyChunked(context.Background(), docChunkTranslator{}, "help/faq.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if !strings.Contains(translated, "阿尔法段") || !strings.Contains(translated, "贝塔段") {
		t.Fatalf("expected translated text after chunk split, got:\n%s", translated)
	}
	if strings.Count(translated, "</Accordion>") != 1 {
		t.Fatalf("expected closing Accordion tag to be preserved after fallback split:\n%s", translated)
	}
}

func TestStripAndReapplyCommonIndent(t *testing.T) {
	t.Parallel()

	source := strings.Join([]string{
		"    <Step title=\"Example\">",
		"      - item one",
		"      - item two",
		"    </Step>",
		"",
	}, "\n")

	normalized, indent := stripCommonIndent(source)
	if indent != "    " {
		t.Fatalf("expected common indent of four spaces, got %q", indent)
	}
	if strings.HasPrefix(normalized, "    ") {
		t.Fatalf("expected normalized text without common indent:\n%s", normalized)
	}
	roundTrip := reapplyCommonIndent(normalized, indent)
	if roundTrip != source {
		t.Fatalf("expected indent round-trip to preserve source\nwant:\n%s\ngot:\n%s", source, roundTrip)
	}
}
