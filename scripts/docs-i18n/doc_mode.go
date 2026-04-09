package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	frontmatterTagStart = "<frontmatter>"
	frontmatterTagEnd   = "</frontmatter>"
	bodyTagStart        = "<body>"
	bodyTagEnd          = "</body>"
)

func processFileDoc(ctx context.Context, translator docsTranslator, docsRoot, filePath, srcLang, tgtLang string, overwrite bool) (bool, string, error) {
	absPath, relPath, err := resolveDocsPath(docsRoot, filePath)
	if err != nil {
		return false, "", err
	}

	content, err := os.ReadFile(absPath)
	if err != nil {
		return false, "", err
	}
	currentHash := hashBytes(content)

	outputPath := filepath.Join(docsRoot, tgtLang, relPath)
	if !overwrite {
		skip, err := shouldSkipDoc(outputPath, currentHash)
		if err != nil {
			return false, "", err
		}
		if skip {
			return true, "", nil
		}
	}

	sourceFront, sourceBody := splitFrontMatter(string(content))
	frontData := map[string]any{}
	if strings.TrimSpace(sourceFront) != "" {
		if err := yaml.Unmarshal([]byte(sourceFront), &frontData); err != nil {
			return false, "", fmt.Errorf("frontmatter parse failed for %s: %w", relPath, err)
		}
	}
	docTM := &TranslationMemory{entries: map[string]TMEntry{}}
	if err := translateFrontMatter(ctx, translator, docTM, frontData, relPath, srcLang, tgtLang); err != nil {
		return false, "", fmt.Errorf("frontmatter translation failed for %s: %w", relPath, err)
	}
	updatedFront, err := encodeFrontMatter(frontData, relPath, content)
	if err != nil {
		return false, "", err
	}
	translatedBody, err := translateDocBodyChunked(ctx, translator, relPath, sourceBody, srcLang, tgtLang)
	if err != nil {
		return false, "", fmt.Errorf("body translate failed for %s: %w", relPath, err)
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return false, "", err
	}

	output := updatedFront + translatedBody
	return false, outputPath, os.WriteFile(outputPath, []byte(output), 0o644)
}

func formatTaggedDocument(frontMatter, body string) string {
	return fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s", frontmatterTagStart, frontMatter, frontmatterTagEnd, bodyTagStart, body, bodyTagEnd)
}

func parseTaggedDocument(text string) (string, string, error) {
	frontStart := strings.Index(text, frontmatterTagStart)
	if frontStart == -1 {
		return "", "", fmt.Errorf("missing %s", frontmatterTagStart)
	}
	frontStart += len(frontmatterTagStart)
	frontEnd := strings.Index(text[frontStart:], frontmatterTagEnd)
	if frontEnd == -1 {
		return "", "", fmt.Errorf("missing %s", frontmatterTagEnd)
	}
	frontEnd += frontStart

	bodyStart := strings.Index(text[frontEnd:], bodyTagStart)
	if bodyStart == -1 {
		return "", "", fmt.Errorf("missing %s", bodyTagStart)
	}
	bodyStart += frontEnd + len(bodyTagStart)

	bodyEnd := strings.LastIndex(text, bodyTagEnd)
	if bodyEnd == -1 || bodyEnd < bodyStart {
		return "", "", fmt.Errorf("missing %s", bodyTagEnd)
	}
	body := trimTagNewlines(text[bodyStart:bodyEnd])
	suffix := strings.TrimSpace(text[bodyEnd+len(bodyTagEnd):])

	prefix := strings.TrimSpace(text[:frontStart-len(frontmatterTagStart)])
	if prefix != "" || suffix != "" {
		return "", "", fmt.Errorf("unexpected text outside tagged sections")
	}

	frontMatter := trimTagNewlines(text[frontStart:frontEnd])
	return frontMatter, body, nil
}

func trimTagNewlines(value string) string {
	value = strings.TrimPrefix(value, "\n")
	value = strings.TrimSuffix(value, "\n")
	return value
}

func shouldSkipDoc(outputPath string, sourceHash string) (bool, error) {
	data, err := os.ReadFile(outputPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	frontMatter, _ := splitFrontMatter(string(data))
	if frontMatter == "" {
		return false, nil
	}
	frontData := map[string]any{}
	if err := yaml.Unmarshal([]byte(frontMatter), &frontData); err != nil {
		return false, nil
	}
	storedHash := extractSourceHash(frontData)
	if storedHash == "" {
		return false, nil
	}
	return strings.EqualFold(storedHash, sourceHash), nil
}

func extractSourceHash(frontData map[string]any) string {
	xi, ok := frontData["x-i18n"].(map[string]any)
	if !ok {
		return ""
	}
	value, ok := xi["source_hash"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func logDocChunkPlan(relPath string, blocks []string, groups [][]string) {
	totalBytes := 0
	for _, block := range blocks {
		totalBytes += len(block)
	}
	log.Printf("docs-i18n: body-chunks %s blocks=%d groups=%d bytes=%d", relPath, len(blocks), len(groups), totalBytes)
}

func resolveDocsPath(docsRoot, filePath string) (string, string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", "", err
	}
	relPath, err := filepath.Rel(docsRoot, absPath)
	if err != nil {
		return "", "", err
	}
	if relPath == "." || relPath == "" {
		return "", "", fmt.Errorf("file %s resolves to docs root %s", absPath, docsRoot)
	}
	if filepath.IsAbs(relPath) || relPath == ".." || strings.HasPrefix(relPath, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("file %s not under docs root %s", absPath, docsRoot)
	}
	return absPath, relPath, nil
}
