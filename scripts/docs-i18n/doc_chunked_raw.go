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
const defaultDocChunkPromptBudget = 15000

var (
	docsFenceRE        = regexp.MustCompile(`^\s*(` + "```" + `|~~~)`)
	docsComponentTagRE = regexp.MustCompile(`<(/?)([A-Z][A-Za-z0-9]*)\b[^>]*?/?>`)
)

var docsProtocolTokens = []string{
	frontmatterTagStart,
	frontmatterTagEnd,
	bodyTagStart,
	bodyTagEnd,
	"[[[FM_",
}

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
	if len(blocks) == 1 {
		if translated, handled, err := translateOversizedDocBlock(ctx, translator, chunkID, source, srcLang, tgtLang, docsI18nDocChunkMaxBytes()); handled {
			return translated, err
		}
	}
	normalizedSource, commonIndent := stripCommonIndent(source)
	estimatedPromptCost := estimateDocPromptCost(normalizedSource)
	if len(blocks) > 1 && estimatedPromptCost > docsI18nDocChunkPromptBudget() {
		mid := len(blocks) / 2
		log.Printf(
			"docs-i18n: chunk pre-split %s blocks=%d est_cost=%d budget=%d",
			chunkID,
			len(blocks),
			estimatedPromptCost,
			docsI18nDocChunkPromptBudget(),
		)
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
	log.Printf("docs-i18n: chunk start %s blocks=%d bytes=%d", chunkID, len(blocks), len(source))
	translated, err := translator.TranslateRaw(ctx, normalizedSource, srcLang, tgtLang)
	if err == nil {
		translated = sanitizeDocChunkProtocolWrappers(source, translated)
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
	logDocChunkSplit(chunkID, len(blocks), err)
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
	if sourceStructure.fenceCount != 0 {
		return "", fmt.Errorf("%s: raw leaf fallback not applicable", chunkID)
	}
	normalizedSource, commonIndent := stripCommonIndent(source)
	maskedSource, placeholders := maskDocComponentTags(normalizedSource)
	translated, err := translator.Translate(ctx, maskedSource, srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	translated, err = restoreDocComponentTags(translated, placeholders)
	if err != nil {
		return "", err
	}
	translated = sanitizeDocChunkProtocolWrappers(source, translated)
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
	fenceDelimiter := ""
	for _, line := range lines {
		current.WriteString(line)
		fenceDelimiter, _ = updateFenceDelimiter(fenceDelimiter, line)
		inFence := fenceDelimiter != ""
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
	if hasUnexpectedTopLevelProtocolWrapper(source, translated) {
		return fmt.Errorf("protocol token leaked: top-level wrapper")
	}
	sourceLower := strings.ToLower(source)
	translatedLower := strings.ToLower(translated)
	for _, token := range docsProtocolTokens {
		tokenLower := strings.ToLower(token)
		if strings.Contains(sourceLower, tokenLower) {
			continue
		}
		if strings.Contains(translatedLower, tokenLower) {
			return fmt.Errorf("protocol token leaked: %s", token)
		}
	}
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

func sanitizeDocChunkProtocolWrappers(source, translated string) string {
	if !containsProtocolWrapperToken(translated) {
		return translated
	}
	trimmedTranslated := strings.TrimSpace(translated)
	if !hasUnexpectedTopLevelProtocolWrapper(source, trimmedTranslated) {
		return translated
	}
	_, body, err := parseTaggedDocument(trimmedTranslated)
	if err == nil {
		if strings.TrimSpace(body) == "" {
			return translated
		}
		return body
	}
	body, ok := stripBodyOnlyWrapper(trimmedTranslated)
	if !ok || strings.TrimSpace(body) == "" {
		return translated
	}
	return body
}

func stripBodyOnlyWrapper(text string) (string, bool) {
	lower := strings.ToLower(text)
	bodyStartLower := strings.ToLower(bodyTagStart)
	bodyEndLower := strings.ToLower(bodyTagEnd)
	if !strings.HasPrefix(lower, bodyStartLower) || !strings.HasSuffix(lower, bodyEndLower) {
		return "", false
	}
	body := text[len(bodyTagStart) : len(text)-len(bodyTagEnd)]
	bodyLower := lower[len(bodyTagStart) : len(lower)-len(bodyTagEnd)]
	if strings.Contains(bodyLower, bodyStartLower) || strings.Contains(bodyLower, bodyEndLower) {
		return "", false
	}
	return trimTagNewlines(body), true
}

func maskDocComponentTags(text string) (string, []string) {
	placeholders := make([]string, 0, 4)
	masked := docsComponentTagRE.ReplaceAllStringFunc(text, func(match string) string {
		placeholder := fmt.Sprintf("__OC_DOC_TAG_%03d__", len(placeholders))
		placeholders = append(placeholders, match)
		return placeholder
	})
	return masked, placeholders
}

func restoreDocComponentTags(text string, placeholders []string) (string, error) {
	restored := text
	for index, original := range placeholders {
		placeholder := fmt.Sprintf("__OC_DOC_TAG_%03d__", index)
		if !strings.Contains(restored, placeholder) {
			return "", fmt.Errorf("component tag placeholder missing: %s", placeholder)
		}
		restored = strings.ReplaceAll(restored, placeholder, original)
	}
	return restored, nil
}

func logDocChunkSplit(chunkID string, blockCount int, err error) {
	if docsI18nVerboseLogs() || blockCount >= 16 {
		log.Printf("docs-i18n: chunk split %s blocks=%d err=%v", chunkID, blockCount, err)
	}
}

func summarizeDocChunkStructure(text string) docChunkStructure {
	counts := map[string]int{}
	lines := strings.Split(text, "\n")
	fenceDelimiter := ""
	for _, line := range lines {
		var toggled bool
		fenceDelimiter, toggled = updateFenceDelimiter(fenceDelimiter, line)
		if toggled {
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

func updateFenceDelimiter(current, line string) (string, bool) {
	delimiter := leadingFenceDelimiter(line)
	if delimiter == "" {
		return current, false
	}
	if current == "" {
		return delimiter, true
	}
	if delimiter[0] == current[0] && len(delimiter) >= len(current) && isClosingFenceLine(line, delimiter) {
		return "", true
	}
	return current, false
}

func leadingFenceDelimiter(line string) string {
	trimmed := strings.TrimLeft(line, " \t")
	if len(trimmed) < 3 {
		return ""
	}
	switch trimmed[0] {
	case '`', '~':
	default:
		return ""
	}
	marker := trimmed[0]
	index := 0
	for index < len(trimmed) && trimmed[index] == marker {
		index++
	}
	if index < 3 {
		return ""
	}
	return trimmed[:index]
}

func isClosingFenceLine(line, delimiter string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if !strings.HasPrefix(trimmed, delimiter) {
		return false
	}
	return strings.TrimSpace(trimmed[len(delimiter):]) == ""
}

func hasUnexpectedTopLevelProtocolWrapper(source, translated string) bool {
	sourceTrimmed := strings.ToLower(strings.TrimSpace(source))
	translatedTrimmed := strings.ToLower(strings.TrimSpace(translated))
	checks := []struct {
		token string
		match func(string) bool
	}{
		{token: frontmatterTagStart, match: func(text string) bool { return strings.HasPrefix(text, strings.ToLower(frontmatterTagStart)) }},
		{token: bodyTagStart, match: func(text string) bool { return strings.HasPrefix(text, strings.ToLower(bodyTagStart)) }},
		{token: frontmatterTagEnd, match: func(text string) bool { return strings.HasSuffix(text, strings.ToLower(frontmatterTagEnd)) }},
		{token: bodyTagEnd, match: func(text string) bool { return strings.HasSuffix(text, strings.ToLower(bodyTagEnd)) }},
	}
	for _, check := range checks {
		if check.match(translatedTrimmed) && !check.match(sourceTrimmed) {
			return true
		}
	}
	return false
}

func containsProtocolWrapperToken(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, strings.ToLower(bodyTagStart)) || strings.Contains(lower, strings.ToLower(frontmatterTagStart))
}

func translateOversizedDocBlock(ctx context.Context, translator docsTranslator, chunkID, block, srcLang, tgtLang string, maxBytes int) (string, bool, error) {
	if maxBytes <= 0 || len(block) <= maxBytes {
		return "", false, nil
	}
	if translated, ok, err := translateOversizedFencedDocBlock(ctx, translator, chunkID, block, srcLang, tgtLang, maxBytes); ok {
		return translated, true, err
	}
	parts, ok := splitDocTextByLines(block, maxBytes)
	if !ok {
		return "", false, nil
	}
	log.Printf("docs-i18n: chunk singleton-split %s parts=%d bytes=%d", chunkID, len(parts), len(block))
	var out strings.Builder
	for index, part := range parts {
		translated, err := translateDocBlockGroup(ctx, translator, fmt.Sprintf("%s.%02d", chunkID, index+1), []string{part}, srcLang, tgtLang)
		if err != nil {
			return "", true, err
		}
		out.WriteString(translated)
	}
	return out.String(), true, nil
}

func translateOversizedFencedDocBlock(ctx context.Context, translator docsTranslator, chunkID, block, srcLang, tgtLang string, maxBytes int) (string, bool, error) {
	lines := strings.SplitAfter(block, "\n")
	if len(lines) < 3 {
		return "", false, nil
	}
	opening := lines[0]
	delimiter := leadingFenceDelimiter(opening)
	if delimiter == "" {
		return "", false, nil
	}
	closingIndex := -1
	for index := len(lines) - 1; index >= 1; index-- {
		if strings.TrimSpace(lines[index]) == "" {
			continue
		}
		if isClosingFenceLine(lines[index], delimiter) {
			closingIndex = index
		}
		break
	}
	if closingIndex < 1 {
		return "", false, nil
	}
	closing := lines[closingIndex]
	inner := strings.Join(lines[1:closingIndex], "")
	trailing := strings.Join(lines[closingIndex+1:], "")
	parts, ok := splitDocTextByLines(inner, maxBytes-len(opening)-len(closing))
	if !ok {
		return "", false, nil
	}
	log.Printf("docs-i18n: chunk singleton-fence-split %s parts=%d bytes=%d", chunkID, len(parts), len(block))
	var innerOut strings.Builder
	for index, part := range parts {
		wrapped := opening + part + closing
		translated, err := translateDocBlockGroup(ctx, translator, fmt.Sprintf("%s.%02d", chunkID, index+1), []string{wrapped}, srcLang, tgtLang)
		if err != nil {
			return "", true, err
		}
		unwrapped, ok := unwrapTranslatedFencedDocChunk(translated, delimiter)
		if !ok {
			return "", true, fmt.Errorf("%s.%02d: fenced chunk lost wrapper", chunkID, index+1)
		}
		innerOut.WriteString(unwrapped)
	}
	return opening + innerOut.String() + closing + trailing, true, nil
}

func splitDocTextByLines(text string, maxBytes int) ([]string, bool) {
	if maxBytes <= 0 {
		return nil, false
	}
	lines := strings.SplitAfter(text, "\n")
	if len(lines) <= 1 {
		return nil, false
	}
	parts := make([]string, 0, len(lines))
	var current strings.Builder
	currentBytes := 0
	for _, line := range lines {
		if len(line) > maxBytes {
			return nil, false
		}
		if currentBytes > 0 && currentBytes+len(line) > maxBytes {
			parts = append(parts, current.String())
			current.Reset()
			currentBytes = 0
		}
		current.WriteString(line)
		currentBytes += len(line)
	}
	if current.Len() > 0 {
		parts = append(parts, current.String())
	}
	if len(parts) <= 1 {
		return nil, false
	}
	return parts, true
}

func unwrapTranslatedFencedDocChunk(text, delimiter string) (string, bool) {
	lines := strings.SplitAfter(text, "\n")
	if len(lines) < 2 {
		return "", false
	}
	if leadingFenceDelimiter(lines[0]) == "" {
		return "", false
	}
	closingIndex := -1
	for index := len(lines) - 1; index >= 1; index-- {
		if strings.TrimSpace(lines[index]) == "" {
			continue
		}
		if isClosingFenceLine(lines[index], delimiter) {
			closingIndex = index
		}
		break
	}
	if closingIndex < 1 {
		return "", false
	}
	return strings.Join(lines[1:closingIndex], ""), true
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

func docsI18nDocChunkPromptBudget() int {
	value := strings.TrimSpace(os.Getenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_PROMPT_BUDGET"))
	if value == "" {
		return defaultDocChunkPromptBudget
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return defaultDocChunkPromptBudget
	}
	return parsed
}

func estimateDocPromptCost(text string) int {
	cost := len(text)
	cost += strings.Count(text, "`") * 6
	cost += strings.Count(text, "|") * 4
	cost += strings.Count(text, "{") * 4
	cost += strings.Count(text, "}") * 4
	cost += strings.Count(text, "[") * 4
	cost += strings.Count(text, "]") * 4
	cost += strings.Count(text, ":") * 2
	cost += strings.Count(text, "<") * 4
	cost += strings.Count(text, ">") * 4
	return cost
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
