package main

import (
	"errors"
	"testing"
)

func TestDocsI18nProviderUsesOpenAI(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "anthropic")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")

	if got := docsI18nProvider(); got != "openai" {
		t.Fatalf("expected OpenAI provider, got %q", got)
	}
}

func TestDocsI18nModelKeepsOpenAIDefaultAtGPT55(t *testing.T) {
	t.Setenv(envDocsI18nModel, "")

	if got := docsI18nModel(); got != defaultOpenAIModel {
		t.Fatalf("expected OpenAI default model %q, got %q", defaultOpenAIModel, got)
	}
}

func TestDocsI18nModelPrefersExplicitOverride(t *testing.T) {
	t.Setenv(envDocsI18nModel, "__test_model_override__")

	if got := docsI18nModel(); got != "__test_model_override__" {
		t.Fatalf("expected explicit model override, got %q", got)
	}
}

func TestIsCJK(t *testing.T) {
	tests := []struct {
		r    rune
		want bool
	}{
		{'中', true},
		{'文', true},
		{'日', true},
		{'本', true},
		{'A', false},
		{'1', false},
		{' ', false},
		{'ä', false},
		{'é', false},
		{'ç', false},
		{'à', false},
		{'—', false}, // em dash
		{'·', false}, // middle dot (Latin-1 Supplement)
	}
	for _, tt := range tests {
		if got := isCJK(tt.r); got != tt.want {
			t.Errorf("isCJK(%q) = %v, want %v", tt.r, got, tt.want)
		}
	}
}

func TestValidateTargetLanguageOutputChinese_OK(t *testing.T) {
	validTexts := []string{
		"本文档描述了当前首次运行设置流程",
		"OpenClaw Gateway 网关配置",
		"",
		"Hello World",          // English-only is fine for short snippets
		"API v2.0 配置指南",      // Mixed with digits and Latin chars
	}
	for _, text := range validTexts {
		if err := validateTargetLanguageOutput(text, "zh-CN"); err != nil {
			t.Errorf("validateTargetLanguageOutput(%q, zh-CN) unexpected error: %v", text, err)
		}
	}
}

func TestValidateTargetLanguageOutputChinese_Mojibake(t *testing.T) {
	// Classic UTF-8→Latin-1 mojibake: Chinese "配置指南" (UTF-8: E9 85 8D E7 BD AE E6 8C 87 E5 8D 97)
	// interpreted as Latin-1: éç½®æå
	mojibakeTexts := []string{
		"éç½®æåææ¡£",  // "配置指南文档" as mojibake
		"ä¸­æä¹±ç æ£æµ",    // "中文乱码检测" as mojibake
	}
	for _, text := range mojibakeTexts {
		err := validateTargetLanguageOutput(text, "zh-CN")
		if err == nil {
			t.Errorf("validateTargetLanguageOutput(%q, zh-CN) expected error, got nil", text)
		}
		if !errors.Is(err, errSuspectedMojibake) {
			t.Errorf("validateTargetLanguageOutput(%q, zh-CN) error should wrap errSuspectedMojibake, got: %v", text, err)
		}
	}
}

func TestValidateTargetLanguageOutputNonChinese_Skipped(t *testing.T) {
	// Non-Chinese targets should not be validated
	text := "éç½®æå"
	for _, lang := range []string{"ja-JP", "ko", "es", "en", ""} {
		if err := validateTargetLanguageOutput(text, lang); err != nil {
			t.Errorf("validateTargetLanguageOutput(%q, %s) should skip, got error: %v", text, lang, err)
		}
	}
}

func TestValidateTargetLanguageOutputShortText_NoFalsePositive(t *testing.T) {
	// Short text with a few Latin-1 Supplement chars but under threshold
	shortTexts := []string{
		"OK",                         // too short to trigger
		"© 2026 OpenClaw",           // Latin-1 but under threshold
	}
	for _, text := range shortTexts {
		if err := validateTargetLanguageOutput(text, "zh-CN"); err != nil {
			t.Errorf("validateTargetLanguageOutput(%q, zh-CN) unexpected error on short text: %v", text, err)
		}
	}
}
