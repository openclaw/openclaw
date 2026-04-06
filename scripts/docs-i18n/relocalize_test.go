package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPostprocessLocalizedDocsFixesStaleLinksAfterLaterPagesExist(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	writeFile(t, filepath.Join(docsRoot, "gateway", "index.md"), "# Gateway\n")
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "index.md"), stringsJoin(
		"---",
		"title: 网关",
		"x-i18n:",
		"  source_hash: test",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "troubleshooting.md"), stringsJoin(
		"---",
		"title: 故障排除",
		"x-i18n:",
		"  source_hash: test",
		"---",
		"",
		"# 故障排除",
	))

	if err := postprocessLocalizedDocs(docsRoot, "zh-CN"); err != nil {
		t.Fatalf("postprocessLocalizedDocs failed: %v", err)
	}

	got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "index.md"))
	want := "See [Troubleshooting](/zh-CN/gateway/troubleshooting)."
	if !containsLine(got, want) {
		t.Fatalf("expected rewritten localized link %q in output:\n%s", want, got)
	}
}

func stringsJoin(lines ...string) string {
	result := ""
	for i, line := range lines {
		if i > 0 {
			result += "\n"
		}
		result += line
	}
	return result
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed for %s: %v", path, err)
	}
	return string(data)
}

func containsLine(text, want string) bool {
	for _, line := range strings.Split(text, "\n") {
		if line == want {
			return true
		}
	}
	return false
}
