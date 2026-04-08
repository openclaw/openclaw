package main

import (
	"strings"
	"testing"
)

func TestExtractTranslationResultIncludesStopReasonAndPreview(t *testing.T) {
	t.Parallel()

	raw := []byte(`{
		"type":"agent_end",
		"messages":[
			{
				"role":"assistant",
				"stopReason":"terminated",
				"content":[
					{"type":"text","text":"provider disconnected while streaming the translation chunk"}
				]
			}
		]
	}`)

	_, err := extractTranslationResult(raw)
	if err == nil {
		t.Fatal("expected error")
	}
	message := err.Error()
	for _, want := range []string{
		"pi error:",
		"stopReason=terminated",
		"assistant=provider disconnected while streaming the translation chunk",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("expected %q in error, got %q", want, message)
		}
	}
}

func TestPreviewPiAssistantTextTruncatesAndFlattensWhitespace(t *testing.T) {
	t.Parallel()

	input := "line one\n\nline   two\tline three " + strings.Repeat("x", 200)
	preview := previewPiAssistantText(input)
	if strings.Contains(preview, "\n") {
		t.Fatalf("expected flattened whitespace, got %q", preview)
	}
	if !strings.HasPrefix(preview, "line one line two line three ") {
		t.Fatalf("unexpected preview prefix: %q", preview)
	}
	if !strings.HasSuffix(preview, "...") {
		t.Fatalf("expected truncation suffix, got %q", preview)
	}
}
