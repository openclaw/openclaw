package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	translateMaxAttempts = 3
	translateBaseDelay   = 15 * time.Second
	translatePromptTimeout = 2 * time.Minute
)

var errEmptyTranslation = errors.New("empty translation")

type PiTranslator struct {
	client *docsPiClient
}

func NewPiTranslator(srcLang, tgtLang string, glossary []GlossaryEntry, thinking string) (*PiTranslator, error) {
	client, err := startDocsPiClient(context.Background(), docsPiClientOptions{
		SystemPrompt: translationPrompt(srcLang, tgtLang, glossary),
		Thinking:     normalizeThinking(thinking),
	})
	if err != nil {
		return nil, err
	}
	return &PiTranslator{client: client}, nil
}

func (t *PiTranslator) Translate(ctx context.Context, text, srcLang, tgtLang string) (string, error) {
	return t.translate(ctx, text, t.translateMasked)
}

func (t *PiTranslator) TranslateRaw(ctx context.Context, text, srcLang, tgtLang string) (string, error) {
	return t.translate(ctx, text, t.translateRaw)
}

func (t *PiTranslator) translate(ctx context.Context, text string, run func(context.Context, string) (string, error)) (string, error) {
	if t.client == nil {
		return "", errors.New("pi client unavailable")
	}
	prefix, core, suffix := splitWhitespace(text)
	if core == "" {
		return text, nil
	}
	translated, err := t.translateWithRetry(ctx, func(ctx context.Context) (string, error) {
		return run(ctx, core)
	})
	if err != nil {
		return "", err
	}
	return prefix + translated + suffix, nil
}

func (t *PiTranslator) translateWithRetry(ctx context.Context, run func(context.Context) (string, error)) (string, error) {
	var lastErr error
	for attempt := 0; attempt < translateMaxAttempts; attempt++ {
		translated, err := run(ctx)
		if err == nil {
			return translated, nil
		}
		if !isRetryableTranslateError(err) {
			return "", err
		}
		lastErr = err
		if attempt+1 < translateMaxAttempts {
			delay := translateBaseDelay * time.Duration(attempt+1)
			if err := sleepWithContext(ctx, delay); err != nil {
				return "", err
			}
		}
	}
	return "", lastErr
}

func (t *PiTranslator) translateMasked(ctx context.Context, core string) (string, error) {
	state := NewPlaceholderState(core)
	placeholders := make([]string, 0, 8)
	mapping := map[string]string{}
	masked := maskMarkdown(core, state.Next, &placeholders, mapping)
	resText, err := runPrompt(ctx, t.client, masked)
	if err != nil {
		return "", err
	}
	translated := strings.TrimSpace(resText)
	if translated == "" {
		return "", errEmptyTranslation
	}
	if err := validatePlaceholders(translated, placeholders); err != nil {
		return "", err
	}
	return unmaskMarkdown(translated, placeholders, mapping), nil
}

func (t *PiTranslator) translateRaw(ctx context.Context, core string) (string, error) {
	resText, err := runPrompt(ctx, t.client, core)
	if err != nil {
		return "", err
	}
	translated := strings.TrimSpace(resText)
	if translated == "" {
		return "", errEmptyTranslation
	}
	return translated, nil
}

func isRetryableTranslateError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errEmptyTranslation) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "placeholder missing") || strings.Contains(message, "rate limit") || strings.Contains(message, "429")
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (t *PiTranslator) Close() {
	if t.client != nil {
		_ = t.client.Close()
	}
}

type promptRunner interface {
	Prompt(context.Context, string) (string, error)
	Stderr() string
}

func runPrompt(ctx context.Context, client promptRunner, message string) (string, error) {
	promptCtx, cancel := context.WithTimeout(ctx, translatePromptTimeout)
	defer cancel()

	result, err := client.Prompt(promptCtx, message)
	if err != nil {
		return "", decoratePromptError(err, client.Stderr())
	}
	return result, nil
}

func decoratePromptError(err error, stderr string) error {
	if err == nil {
		return nil
	}
	trimmed := strings.TrimSpace(stderr)
	if trimmed == "" {
		return err
	}
	return fmt.Errorf("%w (pi stderr: %s)", err, trimmed)
}

func normalizeThinking(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "high":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "high"
	}
}
