package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const defaultDocChunkMaxBytes = 12000

var (
	docsFenceRE        = regexp.MustCompile(`^\s*(` + "```" + `|~~~)`)
	docsComponentTagRE = regexp.MustCompile(`<(/?)([A-Z][A-Za-z0-9]*)\b[^>]*?/?>`)
)

type docChunkStructure struct {
	fenceCount int
	tagCounts  map[string]int
}

func translateDocBodyChunked(ctx context.Context, translator docsTranslator, relPath, body, srcLang, tgtLang string) (string, error) {
	if strings.TrimSpace(body) == "" {
		return body, nil
	}
	blocks := splitDocBodyIntoBlocks(body)
	groups := groupDocBlocks(blocks, docsI18nDocChunkMaxBytes())
	logDocChunkPlan(relPath, blocks, groups)
	out := strings.Builder{}
	for index, group := range groups {
		chunkID := fmt.Sprintf("%s.chunk-%03d", relPath, index+1)
		translated, err := translateDocBlockGroup(ctx, translator, chunkID, group, srcLang, tgtLang)
		if err != nil {
			return "", err
		}
		out.WriteString(translated)
	}
	return out.String(), nil
}

func translateDocBlockGroup(ctx context.Context, translator docsTranslator, chunkID string, blocks []string, srcLang, tgtLang string) (string, error) {
	source := strings.Join(blocks, "")
	if strings.TrimSpace(source) == "" {
		return source, nil
	}
	normalizedSource, commonIndent := stripCommonIndent(source)
	log.Printf("docs-i18n: chunk start %s blocks=%d bytes=%d", chunkID, len(blocks), len(source))
	translated, err := translator.TranslateRaw(ctx, normalizedSource, srcLang, tgtLang)
	if err == nil {
		translated = reapplyCommonIndent(translated, commonIndent)
		if validationErr := validateDocChunkTranslation(source, translated); validationErr == nil {
			log.Printf("docs-i18n: chunk done %s out_bytes=%d", chunkID, len(translated))
			return translated, nil
		} else {
			err = validationErr
		}
	}
	if len(blocks) <= 1 {
		if fallback, fallbackErr := translateDocLeafBlock(ctx, translator, chunkID, source, srcLang, tgtLang); fallbackErr == nil {
			return fallback, nil
		}
		return "", fmt.Errorf("%s: %w", chunkID, err)
	}
	mid := len(blocks) / 2
	log.Printf("docs-i18n: chunk split %s blocks=%d err=%v", chunkID, len(blocks), err)
	left, err := translateDocBlockGroup(ctx, translator, chunkID+"a", blocks[:mid], srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	right, err := translateDocBlockGroup(ctx, translator, chunkID+"b", blocks[mid:], srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	return left + right, nil
}

func translateDocLeafBlock(ctx context.Context, translator docsTranslator, chunkID, source, srcLang, tgtLang string) (string, error) {
	sourceStructure := summarizeDocChunkStructure(source)
	if sourceStructure.fenceCount != 0 || len(sourceStructure.tagCounts) != 0 {
		return "", fmt.Errorf("%s: raw leaf fallback not applicable", chunkID)
	}
	normalizedSource, commonIndent := stripCommonIndent(source)
	translated, err := translator.Translate(ctx, normalizedSource, srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	translated = reapplyCommonIndent(translated, commonIndent)
	if validationErr := validateDocChunkTranslation(source, translated); validationErr != nil {
		return "", validationErr
	}
	log.Printf("docs-i18n: chunk leaf-fallback done %s out_bytes=%d", chunkID, len(translated))
	return translated, nil
}

func splitDocBodyIntoBlocks(body string) []string {
	if body == "" {
		return nil
	}
	lines := strings.SplitAfter(body, "\n")
	blocks := make([]string, 0, len(lines))
	var current strings.Builder
	inFence := false
	for _, line := range lines {
		current.WriteString(line)
		if togglesFence(line) {
			inFence = !inFence
		}
		if !inFence && strings.TrimSpace(line) == "" {
			blocks = append(blocks, current.String())
			current.Reset()
		}
	}
	if current.Len() > 0 {
		blocks = append(blocks, current.String())
	}
	if len(blocks) == 0 {
		return []string{body}
	}
	return blocks
}

func groupDocBlocks(blocks []string, maxBytes int) [][]string {
	if len(blocks) == 0 {
		return nil
	}
	if maxBytes <= 0 {
		maxBytes = defaultDocChunkMaxBytes
	}
	groups := make([][]string, 0, len(blocks))
	current := make([]string, 0, 8)
	currentBytes := 0
	flush := func() {
		if len(current) == 0 {
			return
		}
		groups = append(groups, current)
		current = make([]string, 0, 8)
		currentBytes = 0
	}
	for _, block := range blocks {
		blockBytes := len(block)
		if len(current) > 0 && currentBytes+blockBytes > maxBytes {
			flush()
		}
		if blockBytes > maxBytes {
			groups = append(groups, []string{block})
			continue
		}
		current = append(current, block)
		currentBytes += blockBytes
	}
	flush()
	return groups
}

func validateDocChunkTranslation(source, translated string) error {
	sourceStructure := summarizeDocChunkStructure(source)
	translatedStructure := summarizeDocChunkStructure(translated)
	if sourceStructure.fenceCount != translatedStructure.fenceCount {
		return fmt.Errorf("code fence mismatch: source=%d translated=%d", sourceStructure.fenceCount, translatedStructure.fenceCount)
	}
	if !slices.Equal(sortedKeys(sourceStructure.tagCounts), sortedKeys(translatedStructure.tagCounts)) {
		return fmt.Errorf("component tag set mismatch")
	}
	for _, key := range sortedKeys(sourceStructure.tagCounts) {
		if sourceStructure.tagCounts[key] != translatedStructure.tagCounts[key] {
			return fmt.Errorf("component tag mismatch for %s: source=%d translated=%d", key, sourceStructure.tagCounts[key], translatedStructure.tagCounts[key])
		}
	}
	return nil
}

func summarizeDocChunkStructure(text string) docChunkStructure {
	counts := map[string]int{}
	lines := strings.Split(text, "\n")
	for _, line := range lines {
		if togglesFence(line) {
			counts["__fence_toggle__"]++
		}
		for _, match := range docsComponentTagRE.FindAllStringSubmatch(line, -1) {
			if len(match) < 3 {
				continue
			}
			fullToken := match[0]
			tagName := match[2]
			direction := "open"
			if match[1] == "/" {
				direction = "close"
			}
			if strings.HasSuffix(fullToken, "/>") {
				direction = "self"
			}
			counts[tagName+":"+direction]++
		}
	}
	return docChunkStructure{
		fenceCount: counts["__fence_toggle__"],
		tagCounts:  countsWithoutFence(counts),
	}
}

func countsWithoutFence(counts map[string]int) map[string]int {
	filtered := map[string]int{}
	for key, value := range counts {
		if key == "__fence_toggle__" {
			continue
		}
		filtered[key] = value
	}
	return filtered
}

func sortedKeys(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func applyComponentLine(stack []string, line string) []string {
	matches := docsComponentTagRE.FindAllStringSubmatch(line, -1)
	if len(matches) == 0 {
		return stack
	}
	next := append([]string{}, stack...)
	for _, match := range matches {
		if len(match) < 3 {
			continue
		}
		fullToken := match[0]
		tagName := match[2]
		if strings.HasSuffix(fullToken, "/>") {
			continue
		}
		if match[1] == "/" {
			next = popComponent(next, tagName)
			continue
		}
		next = append(next, tagName)
	}
	return next
}

func popComponent(stack []string, tagName string) []string {
	for index := len(stack) - 1; index >= 0; index-- {
		if stack[index] != tagName {
			continue
		}
		return append(stack[:index], stack[index+1:]...)
	}
	return stack
}

func togglesFence(line string) bool {
	return docsFenceRE.MatchString(line)
}

func docsI18nDocChunkMaxBytes() int {
	value := strings.TrimSpace(os.Getenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES"))
	if value == "" {
		return defaultDocChunkMaxBytes
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return defaultDocChunkMaxBytes
	}
	return parsed
}

func stripCommonIndent(text string) (string, string) {
	lines := strings.SplitAfter(text, "\n")
	common := ""
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		indent := leadingIndent(trimmed)
		if common == "" {
			common = indent
			continue
		}
		common = commonIndentPrefix(common, indent)
		if common == "" {
			return text, ""
		}
	}
	if common == "" {
		return text, ""
	}
	var out strings.Builder
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(trimmed) == "" {
			out.WriteString(line)
			continue
		}
		if strings.HasPrefix(line, common) {
			out.WriteString(strings.TrimPrefix(line, common))
			continue
		}
		out.WriteString(line)
	}
	return out.String(), common
}

func reapplyCommonIndent(text, indent string) string {
	if indent == "" || text == "" {
		return text
	}
	lines := strings.SplitAfter(text, "\n")
	var out strings.Builder
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(trimmed) == "" {
			out.WriteString(line)
			continue
		}
		out.WriteString(indent)
		out.WriteString(line)
	}
	return out.String()
}

func leadingIndent(line string) string {
	index := 0
	for index < len(line) {
		if line[index] != ' ' && line[index] != '\t' {
			break
		}
		index++
	}
	return line[:index]
}

func commonIndentPrefix(a, b string) string {
	limit := len(a)
	if len(b) < limit {
		limit = len(b)
	}
	index := 0
	for index < limit && a[index] == b[index] {
		index++
	}
	return a[:index]
}
