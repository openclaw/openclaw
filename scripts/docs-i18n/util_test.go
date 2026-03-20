package main

import "testing"

func TestDocsPiProviderPrefersExplicitOverride(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "anthropic")
	t.Setenv("OPENAI_API_KEY", "openai-key")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")

	if got := docsPiProvider(); got != "anthropic" {
		t.Fatalf("expected anthropic override, got %q", got)
	}
}

func TestDocsPiProviderPrefersOpenAIEnvWhenAvailable(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "")
	t.Setenv("OPENAI_API_KEY", "openai-key")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")

	if got := docsPiProvider(); got != "openai" {
		t.Fatalf("expected openai provider, got %q", got)
	}
}

func TestDocsPiModelUsesProviderDefault(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "anthropic")
	t.Setenv(envDocsI18nModel, "")

	if got := docsPiModel(); got != defaultAnthropicModel {
		t.Fatalf("expected anthropic default model, got %q", got)
	}
}

func TestDocsPiModelKeepsOpenAIDefaultAtGPT54(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "")

	if got := docsPiModel(); got != defaultOpenAIModel {
		t.Fatalf("expected OpenAI default model %q, got %q", defaultOpenAIModel, got)
	}
}

func TestDocsPiModelPrefersExplicitOverride(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "gpt-5.2")

	if got := docsPiModel(); got != "gpt-5.2" {
		t.Fatalf("expected explicit model override, got %q", got)
	}
}
