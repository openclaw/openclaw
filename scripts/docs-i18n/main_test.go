package main

import (
	"context"
	"os"
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

func TestRunDocsI18NOnlyBecomesSkippableAfterPostprocessSucceeds(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	sourcePath := filepath.Join(docsRoot, "gateway", "index.md")
	writeFile(t, sourcePath, stringsJoin(
		"---",
		"title: Gateway",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
	skip, outputPath, err := processFileDoc(context.Background(), fakeDocsTranslator{}, docsRoot, sourcePath, "en", "zh-CN", true)
	if err != nil {
		t.Fatalf("processFileDoc failed: %v", err)
	}
	if skip {
		t.Fatal("processFileDoc unexpectedly skipped translation")
	}

	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("read source failed: %v", err)
	}
	canSkip, err := shouldSkipDoc(outputPath, hashBytes(sourceBytes), "zh-CN")
	if err != nil {
		t.Fatalf("shouldSkipDoc before postprocess failed: %v", err)
	}
	if canSkip {
		t.Fatal("expected pending postprocess output to remain non-skippable")
	}

	if err := postprocessLocalizedDocs(docsRoot, "zh-CN", []string{outputPath}); err != nil {
		t.Fatalf("postprocessLocalizedDocs failed: %v", err)
	}

	canSkip, err = shouldSkipDoc(outputPath, hashBytes(sourceBytes), "zh-CN")
	if err != nil {
		t.Fatalf("shouldSkipDoc after postprocess failed: %v", err)
	}
	if !canSkip {
		t.Fatalf("expected postprocessed output to become skippable:\n%s", mustReadFile(t, outputPath))
	}
}

func TestShouldSkipDocKeepsEnglishTargetsHashOnly(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	sourcePath := filepath.Join(docsRoot, "gateway", "index.md")
	writeFile(t, sourcePath, stringsJoin(
		"---",
		"title: Gateway",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))
	outputPath := filepath.Join(docsRoot, "en", "gateway", "index.md")
	writeFile(t, outputPath, stringsJoin(
		"---",
		"title: Gateway",
		"x-i18n:",
		"  source_hash: "+hashBytes([]byte(mustReadFile(t, sourcePath))),
		"  postprocess_version: pending",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))

	canSkip, err := shouldSkipDoc(outputPath, hashBytes([]byte(mustReadFile(t, sourcePath))), "en")
	if err != nil {
		t.Fatalf("shouldSkipDoc for English target failed: %v", err)
	}
	if !canSkip {
		t.Fatal("expected English target to remain skippable with matching source hash")
	}
}
