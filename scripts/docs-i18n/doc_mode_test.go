package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestShouldSkipDoc_MatchingSourceAndPolicy(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	outputPath := filepath.Join(dir, "output.md")
	source := []byte("source content")
	policyHash := "policy-v1"
	content, err := encodeFrontMatter(map[string]any{}, "help/faq.md", source, policyHash)
	if err != nil {
		t.Fatalf("encodeFrontMatter failed: %v", err)
	}
	content += "# translated\n"
	if err := os.WriteFile(outputPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write output failed: %v", err)
	}

	skip, err := shouldSkipDoc(outputPath, hashBytes(source), policyHash)
	if err != nil {
		t.Fatalf("shouldSkipDoc failed: %v", err)
	}
	if !skip {
		t.Fatalf("expected skip=true when source and policy hashes match")
	}
}

func TestShouldSkipDoc_PolicyChangedDoesNotSkip(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	outputPath := filepath.Join(dir, "output.md")
	source := []byte("source content")
	content, err := encodeFrontMatter(map[string]any{}, "help/faq.md", source, "policy-old")
	if err != nil {
		t.Fatalf("encodeFrontMatter failed: %v", err)
	}
	content += "# translated\n"
	if err := os.WriteFile(outputPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write output failed: %v", err)
	}

	skip, err := shouldSkipDoc(outputPath, hashBytes(source), "policy-new")
	if err != nil {
		t.Fatalf("shouldSkipDoc failed: %v", err)
	}
	if skip {
		t.Fatalf("expected skip=false when policy hash changes")
	}
}

func TestShouldSkipDoc_MissingPolicyInLegacyOutputDoesNotSkip(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	outputPath := filepath.Join(dir, "output.md")
	source := []byte("source content")
	content, err := encodeFrontMatter(map[string]any{}, "help/faq.md", source, "")
	if err != nil {
		t.Fatalf("encodeFrontMatter failed: %v", err)
	}
	content += "# translated\n"
	if err := os.WriteFile(outputPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write output failed: %v", err)
	}

	skip, err := shouldSkipDoc(outputPath, hashBytes(source), "policy-v2")
	if err != nil {
		t.Fatalf("shouldSkipDoc failed: %v", err)
	}
	if skip {
		t.Fatalf("expected skip=false for legacy outputs that do not have policy hash")
	}
}
