package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	pi "github.com/joshp123/pi-golang"
)

type PiTranslator struct {
	client *pi.OneShotClient
}

func NewPiTranslator(srcLang, tgtLang string, glossary []GlossaryEntry) (*PiTranslator, error) {
	options := pi.DefaultOneShotOptions()
	options.AppName = "openclaw-docs-i18n"
	options.Mode = pi.ModeDragons
	options.Dragons = pi.DragonsOptions{
		Provider: "anthropic",
		Model:    modelVersion,
		Thinking: "high",
	}
	options.SystemPrompt = translationPrompt(srcLang, tgtLang, glossary)
	client, err := pi.StartOneShot(options)
	if err != nil {
		return nil, err
	}
	return &PiTranslator{client: client}, nil
}

func (t *PiTranslator) Translate(ctx context.Context, text, srcLang, tgtLang string) (string, error) {
	if t.client == nil {
		return "", errors.New("pi client unavailable")
	}
	prefix, core, suffix := splitWhitespace(text)
	if core == "" {
		return text, nil
	}
	state := NewPlaceholderState(core)
	placeholders := make([]string, 0, 8)
	mapping := map[string]string{}
	masked := maskMarkdown(core, state.Next, &placeholders, mapping)
	res, err := t.client.Run(ctx, masked)
	if err != nil {
		return "", err
	}
	translated := strings.TrimSpace(res.Text)
	if err := validatePlaceholders(translated, placeholders); err != nil {
		return "", err
	}
	translated = unmaskMarkdown(translated, placeholders, mapping)
	return prefix + translated + suffix, nil
}

func (t *PiTranslator) Close() {
	if t.client != nil {
		_ = t.client.Close()
	}
}

func translationPrompt(srcLang, tgtLang string, glossary []GlossaryEntry) string {
	srcLabel := srcLang
	tgtLabel := tgtLang
	if strings.EqualFold(srcLang, "en") {
		srcLabel = "English"
	}
	if strings.EqualFold(tgtLang, "zh-CN") {
		tgtLabel = "Simplified Chinese"
	}
	glossaryBlock := buildGlossaryPrompt(glossary)
	return strings.TrimSpace(fmt.Sprintf(`You are a translation function, not a chat assistant.
Translate from %s to %s.

Rules:
- Output ONLY the translated text. No preamble, no questions, no commentary.
- Preserve Markdown syntax exactly (headings, lists, tables, emphasis).
- Do not translate code spans/blocks, config keys, CLI flags, or env vars.
- Do not alter URLs or anchors.
- Preserve placeholders exactly: __OC_I18N_####__.
- Use neutral technical Chinese; avoid slang or jokes.
- Keep product names in English: OpenClaw, Gateway, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.

%s

If the input is empty, output empty.
If the input contains only placeholders, output it unchanged.`, srcLabel, tgtLabel, glossaryBlock))
}

func buildGlossaryPrompt(glossary []GlossaryEntry) string {
	if len(glossary) == 0 {
		return ""
	}
	var lines []string
	lines = append(lines, "Preferred translations (use when natural):")
	for _, entry := range glossary {
		if entry.Source == "" || entry.Target == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s -> %s", entry.Source, entry.Target))
	}
	return strings.Join(lines, "\n")
}
