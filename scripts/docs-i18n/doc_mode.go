package main

import (
	"context"
	"fmt"
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

func processFileDoc(ctx context.Context, translator *PiTranslator, docsRoot, filePath, srcLang, tgtLang string, overwrite bool) (bool, error) {
	absPath, relPath, err := resolveDocsPath(docsRoot, filePath)
	if err != nil {
		return false, err
	}

	content, err := os.ReadFile(absPath)
	if err != nil {
		return false, err
	}
	currentHash := hashBytes(content)

	outputPath := filepath.Join(docsRoot, tgtLang, relPath)
	if !overwrite {
		skip, err := shouldSkipDoc(outputPath, currentHash)
		if err != nil {
			return false, err
		}
		if skip {
			return true, nil
		}
	}

	sourceFront, sourceBody := splitFrontMatter(string(content))
	frontData := map[string]any{}
	if strings.TrimSpace(sourceFront) != "" {
		if err := yaml.Unmarshal([]byte(sourceFront), &frontData); err != nil {
			return false, fmt.Errorf("frontmatter parse failed for %s: %w", relPath, err)
		}
	}
	frontTemplate, markers := buildFrontmatterTemplate(frontData)
	taggedInput := formatTaggedDocument(frontTemplate, sourceBody)

	translatedDoc, err := translator.TranslateRaw(ctx, taggedInput, srcLang, tgtLang)
	if err != nil {
		return false, fmt.Errorf("translate failed (%s): %w", relPath, err)
	}

	translatedFront, translatedBody, err := parseTaggedDocument(translatedDoc)
	if err != nil {
		return false, fmt.Errorf("tagged output invalid for %s: %w", relPath, err)
	}
	if sourceFront != "" && strings.TrimSpace(translatedFront) == "" {
		return false, fmt.Errorf("translation removed frontmatter for %s", relPath)
	}
	if err := applyFrontmatterTranslations(frontData, markers, translatedFront); err != nil {
		return false, fmt.Errorf("frontmatter translation failed for %s: %w", relPath, err)
	}

	updatedFront, err := encodeFrontMatter(frontData, relPath, content)
	if err != nil {
		return false, err
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return false, err
	}

	output := updatedFront + translatedBody
	return false, os.WriteFile(outputPath, []byte(output), 0o644)
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
	bodyEnd := strings.Index(text[bodyStart:], bodyTagEnd)
	if bodyEnd == -1 {
		return "", "", fmt.Errorf("missing %s", bodyTagEnd)
	}
	bodyEnd += bodyStart

	prefix := strings.TrimSpace(text[:frontStart-len(frontmatterTagStart)])
	suffix := strings.TrimSpace(text[bodyEnd+len(bodyTagEnd):])
	if prefix != "" || suffix != "" {
		return "", "", fmt.Errorf("unexpected text outside tagged sections")
	}

	frontMatter := trimTagNewlines(text[frontStart:frontEnd])
	body := trimTagNewlines(text[bodyStart:bodyEnd])
	return frontMatter, body, nil
}

func trimTagNewlines(value string) string {
	value = strings.TrimPrefix(value, "\n")
	value = strings.TrimSuffix(value, "\n")
	return value
}

type frontmatterMarker struct {
	Field string
	Index int
	Start string
	End   string
}

func buildFrontmatterTemplate(data map[string]any) (string, []frontmatterMarker) {
	if len(data) == 0 {
		return "", nil
	}
	markers := []frontmatterMarker{}
	lines := []string{}

	if summary, ok := data["summary"].(string); ok {
		start, end := markerPair("SUMMARY", 0)
		markers = append(markers, frontmatterMarker{Field: "summary", Index: 0, Start: start, End: end})
		lines = append(lines, fmt.Sprintf("summary: %s%s%s", start, summary, end))
	}

	if title, ok := data["title"].(string); ok {
		start, end := markerPair("TITLE", 0)
		markers = append(markers, frontmatterMarker{Field: "title", Index: 0, Start: start, End: end})
		lines = append(lines, fmt.Sprintf("title: %s%s%s", start, title, end))
	}

	if readWhen, ok := data["read_when"].([]any); ok {
		lines = append(lines, "read_when:")
		for idx, item := range readWhen {
			textValue, ok := item.(string)
			if !ok {
				lines = append(lines, fmt.Sprintf("  - %v", item))
				continue
			}
			start, end := markerPair("READ_WHEN", idx)
			markers = append(markers, frontmatterMarker{Field: "read_when", Index: idx, Start: start, End: end})
			lines = append(lines, fmt.Sprintf("  - %s%s%s", start, textValue, end))
		}
	}

	return strings.Join(lines, "\n"), markers
}

func markerPair(field string, index int) (string, string) {
	return fmt.Sprintf("[[[FM_%s_%d_START]]]", field, index), fmt.Sprintf("[[[FM_%s_%d_END]]]", field, index)
}

func applyFrontmatterTranslations(data map[string]any, markers []frontmatterMarker, translatedFront string) error {
	if len(markers) == 0 {
		return nil
	}
	for _, marker := range markers {
		value, err := extractMarkerValue(translatedFront, marker.Start, marker.End)
		if err != nil {
			return err
		}
		value = strings.TrimSpace(value)
		switch marker.Field {
		case "summary":
			data["summary"] = value
		case "title":
			data["title"] = value
		case "read_when":
			data["read_when"] = setReadWhenValue(data["read_when"], marker.Index, value)
		}
	}
	return nil
}

func extractMarkerValue(text, start, end string) (string, error) {
	startIndex := strings.Index(text, start)
	if startIndex == -1 {
		return "", fmt.Errorf("missing marker %s", start)
	}
	startIndex += len(start)
	endIndex := strings.Index(text[startIndex:], end)
	if endIndex == -1 {
		return "", fmt.Errorf("missing marker %s", end)
	}
	endIndex += startIndex
	return text[startIndex:endIndex], nil
}

func setReadWhenValue(existing any, index int, value string) []any {
	readWhen, ok := existing.([]any)
	if !ok {
		readWhen = []any{}
	}
	for len(readWhen) <= index {
		readWhen = append(readWhen, "")
	}
	readWhen[index] = value
	return readWhen
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
