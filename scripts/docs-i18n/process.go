package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

func processFile(ctx context.Context, translator *PiTranslator, tm *TranslationMemory, docsRoot, filePath, srcLang, tgtLang string) (bool, error) {
	absPath, relPath, err := resolveDocsPath(docsRoot, filePath)
	if err != nil {
		return false, err
	}

	content, err := os.ReadFile(absPath)
	if err != nil {
		return false, err
	}

	frontMatter, body := splitFrontMatter(string(content))
	frontData := map[string]any{}
	if frontMatter != "" {
		if err := yaml.Unmarshal([]byte(frontMatter), &frontData); err != nil {
			return false, fmt.Errorf("frontmatter parse failed for %s: %w", relPath, err)
		}
	}

	if err := translateFrontMatter(ctx, translator, tm, frontData, relPath, srcLang, tgtLang); err != nil {
		return false, err
	}

	body, err = translateHTMLBlocks(ctx, translator, body, srcLang, tgtLang)
	if err != nil {
		return false, err
	}

	segments, err := extractSegments(body, relPath)
	if err != nil {
		return false, err
	}

	namespace := cacheNamespace()
	for i := range segments {
		seg := &segments[i]
		seg.CacheKey = cacheKey(namespace, srcLang, tgtLang, seg.SegmentID, seg.TextHash)
		if entry, ok := tm.Get(seg.CacheKey); ok {
			seg.Translated = entry.Translated
			continue
		}
		translated, err := translator.Translate(ctx, seg.Text, srcLang, tgtLang)
		if err != nil {
			return false, fmt.Errorf("translate failed (%s): %w", relPath, err)
		}
		seg.Translated = translated
		entry := TMEntry{
			CacheKey:   seg.CacheKey,
			SegmentID:  seg.SegmentID,
			SourcePath: relPath,
			TextHash:   seg.TextHash,
			Text:       seg.Text,
			Translated: translated,
			Provider:   providerName,
			Model:      modelVersion,
			SrcLang:    srcLang,
			TgtLang:    tgtLang,
			UpdatedAt:  time.Now().UTC().Format(time.RFC3339),
		}
		tm.Put(entry)
	}

	translatedBody := applyTranslations(body, segments)
	updatedFront, err := encodeFrontMatter(frontData, relPath, content)
	if err != nil {
		return false, err
	}

	outputPath := filepath.Join(docsRoot, tgtLang, relPath)
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return false, err
	}

	output := updatedFront + translatedBody
	return false, os.WriteFile(outputPath, []byte(output), 0o644)
}

func splitFrontMatter(content string) (string, string) {
	if !strings.HasPrefix(content, "---") {
		return "", content
	}
	lines := strings.Split(content, "\n")
	if len(lines) < 2 {
		return "", content
	}
	endIndex := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			endIndex = i
			break
		}
	}
	if endIndex == -1 {
		return "", content
	}
	front := strings.Join(lines[1:endIndex], "\n")
	body := strings.Join(lines[endIndex+1:], "\n")
	if strings.HasPrefix(body, "\n") {
		body = body[1:]
	}
	return front, body
}

func encodeFrontMatter(frontData map[string]any, relPath string, source []byte) (string, error) {
	if frontData == nil {
		frontData = map[string]any{}
	}
	frontData["x-i18n"] = map[string]any{
		"source_path":  relPath,
		"source_hash":  hashBytes(source),
		"provider":     providerName,
		"model":        modelVersion,
		"workflow":     workflowVersion,
		"generated_at": time.Now().UTC().Format(time.RFC3339),
	}
	encoded, err := yaml.Marshal(frontData)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("---\n%s---\n\n", string(encoded)), nil
}

func translateFrontMatter(ctx context.Context, translator *PiTranslator, tm *TranslationMemory, data map[string]any, relPath, srcLang, tgtLang string) error {
	if len(data) == 0 {
		return nil
	}
	if summary, ok := data["summary"].(string); ok {
		translated, err := translateSnippet(ctx, translator, tm, relPath+":frontmatter:summary", summary, srcLang, tgtLang)
		if err != nil {
			return err
		}
		data["summary"] = translated
	}
	if title, ok := data["title"].(string); ok {
		translated, err := translateSnippet(ctx, translator, tm, relPath+":frontmatter:title", title, srcLang, tgtLang)
		if err != nil {
			return err
		}
		data["title"] = translated
	}
	if readWhen, ok := data["read_when"].([]any); ok {
		translated := make([]any, 0, len(readWhen))
		for idx, item := range readWhen {
			textValue, ok := item.(string)
			if !ok {
				translated = append(translated, item)
				continue
			}
			value, err := translateSnippet(ctx, translator, tm, fmt.Sprintf("%s:frontmatter:read_when:%d", relPath, idx), textValue, srcLang, tgtLang)
			if err != nil {
				return err
			}
			translated = append(translated, value)
		}
		data["read_when"] = translated
	}
	return nil
}

func translateSnippet(ctx context.Context, translator *PiTranslator, tm *TranslationMemory, segmentID, textValue, srcLang, tgtLang string) (string, error) {
	if strings.TrimSpace(textValue) == "" {
		return textValue, nil
	}
	namespace := cacheNamespace()
	textHash := hashText(textValue)
	ck := cacheKey(namespace, srcLang, tgtLang, segmentID, textHash)
	if entry, ok := tm.Get(ck); ok {
		return entry.Translated, nil
	}
	translated, err := translator.Translate(ctx, textValue, srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	entry := TMEntry{
		CacheKey:   ck,
		SegmentID:  segmentID,
		SourcePath: segmentID,
		TextHash:   textHash,
		Text:       textValue,
		Translated: translated,
		Provider:   providerName,
		Model:      modelVersion,
		SrcLang:    srcLang,
		TgtLang:    tgtLang,
		UpdatedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	tm.Put(entry)
	return translated, nil
}
