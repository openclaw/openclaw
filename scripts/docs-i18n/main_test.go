package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

type fakeDocsTranslator struct{}

func (fakeDocsTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (fakeDocsTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	// Keep the fake translator deterministic so this test exercises the
	// docs-i18n pipeline wiring and final link relocalization, not model output.
	replaced := strings.NewReplacer(
		"Gateway", "网关",
		"See ", "参见 ",
	).Replace(text)
	return replaced, nil
}

func (fakeDocsTranslator) Close() {}

func TestRunDocsI18NRewritesFinalLocalizedPageLinks(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	writeFile(t, filepath.Join(docsRoot, "gateway", "index.md"), stringsJoin(
		"---",
		"title: Gateway",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
		"",
		"See [Example provider](/providers/example-provider).",
	))
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
	writeFile(t, filepath.Join(docsRoot, "providers", "example-provider.md"), "# Example provider\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "troubleshooting.md"), "# 故障排除\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "providers", "example-provider.md"), "# 示例 provider\n")

	// This is the higher-level regression for the bug fixed in this PR:
	// if the pipeline stops wiring postprocess through the main flow, the final
	// localized output page will keep stale English-root links and this test fails.
	err := runDocsI18N(context.Background(), runConfig{
		targetLang: "zh-CN",
		sourceLang: "en",
		docsRoot:   docsRoot,
		mode:       "doc",
		thinking:   "high",
		overwrite:  true,
		parallel:   1,
	}, []string{filepath.Join(docsRoot, "gateway", "index.md")}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return fakeDocsTranslator{}, nil
	})
	if err != nil {
		t.Fatalf("runDocsI18N failed: %v", err)
	}

	got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "index.md"))
	expected := []string{
		"参见 [Troubleshooting](/zh-CN/gateway/troubleshooting).",
		"参见 [Example provider](/zh-CN/providers/example-provider).",
	}
	for _, want := range expected {
		if !containsLine(got, want) {
			t.Fatalf("expected final localized page link %q in output:\n%s", want, got)
		}
	}
}
