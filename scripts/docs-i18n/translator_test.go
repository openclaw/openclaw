package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexTranslatorAddsTimeout(t *testing.T) {
	var deadline time.Time
	translator := &CodexTranslator{
		systemPrompt: "Translate from English to Chinese.",
		thinking:     "high",
		runPrompt: func(ctx context.Context, req codexPromptRequest) (string, error) {
			var ok bool
			deadline, ok = ctx.Deadline()
			if !ok {
				t.Fatal("expected prompt deadline")
			}
			if req.Message != "Translate me" {
				t.Fatalf("unexpected message %q", req.Message)
			}
			if req.Model != defaultOpenAIModel {
				t.Fatalf("unexpected model %q", req.Model)
			}
			if req.Thinking != "high" {
				t.Fatalf("unexpected thinking %q", req.Thinking)
			}
			return "translated", nil
		},
	}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}

	remaining := time.Until(deadline)
	if remaining <= time.Minute || remaining > docsI18nPromptTimeout() {
		t.Fatalf("unexpected timeout window %s", remaining)
	}
}

func TestDocsI18nPromptTimeoutUsesEnvOverride(t *testing.T) {
	t.Setenv(envDocsI18nPromptTimeout, "5m")

	if got := docsI18nPromptTimeout(); got != 5*time.Minute {
		t.Fatalf("expected 5m timeout, got %s", got)
	}
}

func TestIsRetryableTranslateErrorRejectsDeadlineExceeded(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(context.DeadlineExceeded) {
		t.Fatal("deadline exceeded should not retry")
	}
}

func TestIsRetryableTranslateErrorRejectsAuthenticationFailures(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(errors.New(`Authentication failed for "openai"`)) {
		t.Fatal("auth failures should not retry")
	}
	if isRetryableTranslateError(errors.New("invalid_api_key")) {
		t.Fatal("API key failures should not retry")
	}
}

func TestIsRetryableTranslateErrorRetriesTransientCodexFailures(t *testing.T) {
	t.Parallel()

	for _, message := range []string{
		"codex exec failed: rate limit 429",
		"codex exec failed: stream disconnected",
		"codex exec failed: 503 temporarily unavailable",
	} {
		if !isRetryableTranslateError(errors.New(message)) {
			t.Fatalf("expected retryable error for %q", message)
		}
	}
}

func TestCodexTranslatorRetriesTransientFailure(t *testing.T) {
	previousDelay := translateRetryDelay
	translateRetryDelay = func(int) time.Duration { return 0 }
	defer func() { translateRetryDelay = previousDelay }()

	attempts := 0
	translator := &CodexTranslator{
		systemPrompt: "Translate from English to Chinese.",
		thinking:     "high",
		runPrompt: func(context.Context, codexPromptRequest) (string, error) {
			attempts++
			if attempts == 1 {
				return "", errors.New("codex exec failed: stream disconnected")
			}
			return "translated", nil
		},
	}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}
	if attempts != 2 {
		t.Fatalf("expected 2 attempts, got %d", attempts)
	}
}

func TestBuildCodexTranslationPromptIncludesGuardrailsAndInput(t *testing.T) {
	prompt := buildCodexTranslationPrompt("System prompt.", "Hello\nworld")

	for _, want := range []string{
		"System prompt.",
		"Return only the translated text",
		"<openclaw_docs_i18n_input>",
		"Hello\nworld",
		"</openclaw_docs_i18n_input>",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in prompt:\n%s", want, prompt)
		}
	}
}

func TestRunCodexExecPromptUsesOutputLastMessage(t *testing.T) {
	dir := t.TempDir()
	fakeCodex := filepath.Join(dir, "codex")
	if err := os.WriteFile(fakeCodex, []byte(`#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    out="$1"
  fi
  shift || true
done
cat >/dev/null
if [ -z "${CODEX_HOME:-}" ]; then
  echo "missing CODEX_HOME" >&2
  exit 1
fi
case "$CODEX_HOME" in
  /tmp/*)
    echo "CODEX_HOME must not be under /tmp" >&2
    exit 1
    ;;
esac
printf 'translated from codex\n' > "$out"
`), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	t.Setenv(envDocsI18nCodexExecutable, fakeCodex)

	got, err := runCodexExecPrompt(context.Background(), codexPromptRequest{
		SystemPrompt: "Translate.",
		Message:      "Hello",
		Model:        "gpt-5.5",
		Thinking:     "high",
	})
	if err != nil {
		t.Fatalf("runCodexExecPrompt returned error: %v", err)
	}
	if got != "translated from codex" {
		t.Fatalf("unexpected output %q", got)
	}
}

func TestPreviewCommandOutputFlattensAndTruncates(t *testing.T) {
	input := "line one\n\nline   two\tline three " + strings.Repeat("x", 600)
	preview := previewCommandOutput(input, "")
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
