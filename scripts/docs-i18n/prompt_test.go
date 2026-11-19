package main

import (
	"strings"
	"testing"
)

var supportedPromptLocales = []string{
	"zh-CN", "zh-TW", "ja-JP", "es", "pt-BR", "ko", "de", "fr", "hi", "ar", "it", "vi", "nl", "fa", "ru", "tr", "uk", "id", "pl", "th", "sv",
}

func TestPrettyLanguageLabelCoversEverySupportedLocale(t *testing.T) {
	t.Parallel()

	for _, locale := range supportedPromptLocales {
		if got := prettyLanguageLabel(locale); got == locale {
			t.Errorf("prettyLanguageLabel(%q) = %q; expected a friendly label", locale, got)
		}
	}
	if got := prettyLanguageLabel(" HI "); got != "Hindi" {
		t.Fatalf("prettyLanguageLabel(HI) = %q, want Hindi", got)
	}
	if got := prettyLanguageLabel("RU"); got != "Russian" {
		t.Fatalf("prettyLanguageLabel(RU) = %q, want Russian", got)
	}
}

func TestTranslationPromptUsesSharedContractAndLocaleOverlayForEverySupportedLocale(t *testing.T) {
	t.Parallel()

	for _, target := range supportedPromptLocales {
		t.Run(target, func(t *testing.T) {
			t.Parallel()

			prompt := translationPrompt("en", target)
			for _, want := range []string{
				"Documentation quality rules:",
				"Preserve exact third-party UI labels only when the source clearly uses them as literal interface text",
				"preserve literal UI labels in data cells, but translate generic organizational column headings",
				"Do not preserve ordinary prose merely because it is bold, quoted, title-cased, or inside a table",
				"Preserve literal third-party UI text as described above; translate OpenClaw-owned UI and documentation labels normally",
				"Keep authentication, authorization, credentials, tokens, passwords, secrets, identities, and accounts distinct",
				"Preserve actors, objects, temporal order, negation, conditions, scope, singular/plural meaning, and requirement strength",
				"Preserve every factual value exactly, including numbers, units, versions, ports, limits, durations, paths, and comparison operators",
				"Use one locale-appropriate register within each page. Do not mix formal, informal, honorific, or speech-level forms",
				"Preserve Markdown list nodes exactly: ordered versus unordered kind, nesting, item count, and ordered-list starting number",
				"Preserve HTML/MDX tag names, attribute names, nesting, and structural attribute values exactly",
				"Fenced text, transcript, output, and documentation examples are an exception to the preceding block rule",
				"Preserve link-label association: translate each Markdown link label in place",
				"Preserve every placeholder byte-for-byte and with exactly the same occurrence count as in the input",
				"Never repeat a placeholder when expanding a comparison or clarifying a reference",
				"Express precedence chains as an inline priority order from highest to lowest, naming each item once",
				"Translate user-visible prose inside string-valued component attributes such as “title”, “label”, “description”, and “placeholder”",
				"Keep product names in English: OpenClaw, Raspberry Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal, LINE.",
				"When they name the documented product, provider, protocol, integration, runtime, or plugin, also preserve ambiguous names exactly: Render, Matrix, Raft, Chutes, fal (title: Fal), Fireworks, Meta, Runway, Synthetic, Upstash Box, Lobster, Mantis, Tokenjuice",
				"Translate the same words normally when the source clearly uses them as ordinary prose instead of a name",
				"Locale rules:",
			} {
				if !strings.Contains(prompt, want) {
					t.Fatalf("expected %q in %s prompt:\n%s", want, target, prompt)
				}
			}
			if strings.Contains(prompt, "%!") {
				t.Fatalf("unexpected formatting artifact in %s prompt:\n%s", target, prompt)
			}
		})
	}
}

func TestProtectedProductNameRuleCoversValidatedNames(t *testing.T) {
	t.Parallel()

	rule := protectedProductNameRule()
	for _, name := range append(append([]string{}, alwaysProtectedProductNames...), contextualProtectedProductNames...) {
		if !strings.Contains(rule, name) {
			t.Errorf("protected product name %q missing from prompt rule", name)
		}
	}
}

func TestTranslationPromptDistinguishesDisplayAndStructuralAttributes(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "zh-CN")
	for _, want := range []string{
		"Never change resource or behavior attributes such as “href”, “src”, “id”, “icon”, “path”, “type”, or “default”",
		"Translate user-visible prose inside string-valued component attributes such as “title”, “label”, “description”, and “placeholder”",
		"Do not translate code-like attribute values",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in attribute prompt:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "Preserve HTML tags and attributes exactly") {
		t.Fatalf("prompt must not freeze user-visible component attributes:\n%s", prompt)
	}
}

func TestTranslationPromptDistinguishesTableHeadersFromLiteralUILabels(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "zh-CN")
	for _, want := range []string{
		"translate generic organizational column headings such as “Field”, “Value”, “Description”, “Example”, and “Required”",
		"The same word may be protected when it names an actual UI control elsewhere",
		"Keep each protected label's spelling, capitalization, punctuation, and Markdown emphasis exactly",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in table-label prompt:\n%s", want, prompt)
		}
	}
}

func TestTranslationPromptAddsRepresentativeLocaleRules(t *testing.T) {
	t.Parallel()

	tests := []struct {
		locale string
		wants  []string
	}{
		{locale: "zh-CN", wants: []string{"Simplified Chinese", "你/你的"}},
		{locale: "zh-TW", wants: []string{"Traditional Chinese", "Taiwan terminology", "do not emit Simplified Chinese forms"}},
		{locale: "ja-JP", wants: []string{"Japanese honorifics", "〜でございます", "「 and 」"}},
		{locale: "de", wants: []string{"Sie/Ihr/Ihnen", "du/dein/dir"}},
		{locale: "pt-BR", wants: []string{"Brazilian Portuguese, not European Portuguese"}},
		{locale: "nl", wants: []string{"Use informal “je/jouw” for direct address", "do not switch to formal “u/uw” except inside protected literal quotations"}},
		{locale: "fa", wants: []string{"Persian ی and ک", "right-to-left"}},
		{locale: "ru", wants: []string{"Use established Russian technical terminology"}},
		{locale: "uk", wants: []string{"Ukrainian terminology rather than Russian calques"}},
		{locale: "sv", wants: []string{"Swedish", "du/din/ditt/dina", "natural compound words", "sentence-style capitalization"}},
		{locale: "th", wants: []string{"Do not insert spaces between every Thai word"}},
	}

	for _, test := range tests {
		t.Run(test.locale, func(t *testing.T) {
			t.Parallel()
			prompt := translationPrompt("en", test.locale)
			for _, want := range test.wants {
				if !strings.Contains(prompt, want) {
					t.Fatalf("expected %q in %s prompt:\n%s", want, test.locale, prompt)
				}
			}
		})
	}
}

func TestLocaleOverlaysDoNotRepeatSharedQualityRules(t *testing.T) {
	t.Parallel()

	for locale, rules := range localeRules {
		for _, duplicate := range []string{
			"neutral technical tone",
			"neutral documentation tone",
			"avoid unnecessary English",
			"consistent within a page",
			"mixing speech levels",
		} {
			if strings.Contains(rules, duplicate) {
				t.Errorf("locale %s repeats shared rule %q", locale, duplicate)
			}
		}
	}
}

func TestTranslationPromptLeavesUnknownLocaleWithoutInventedOverlay(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "eo")
	if strings.Contains(prompt, "Locale rules:") {
		t.Fatalf("unexpected locale overlay for unknown locale:\n%s", prompt)
	}
	if !strings.Contains(prompt, "Translate from English to eo.") {
		t.Fatalf("expected unknown locale label to pass through:\n%s", prompt)
	}
}
