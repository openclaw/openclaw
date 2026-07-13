package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var (
	inlineCodeRe  = regexp.MustCompile("`[^`]+`")
	angleLinkRe   = regexp.MustCompile(`<https?://[^>]+>`)
	linkURLRe     = regexp.MustCompile(`\[[^\]]*\]\(([^)]+)\)`)
	placeholderRe = regexp.MustCompile(`__OC_I18N_\d+__`)
)

func maskMarkdown(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	masked := maskMatches(text, inlineCodeRe, nextPlaceholder, placeholders, mapping)
	masked = maskMatches(masked, angleLinkRe, nextPlaceholder, placeholders, mapping)
	masked = maskLinkURLs(masked, nextPlaceholder, placeholders, mapping)
	return masked
}

func maskMarkdownFencedLiterals(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	angleValues, protocolValues, directiveValues := extractMarkdownFencedLiteralValues(text)
	unique := map[string]struct{}{}
	for _, value := range append(append(angleValues, protocolValues...), directiveValues...) {
		if value != "" {
			unique[value] = struct{}{}
		}
	}
	if len(unique) == 0 {
		return text
	}

	values := make([]string, 0, len(unique))
	for value := range unique {
		values = append(values, value)
	}
	sort.Slice(values, func(i, j int) bool {
		return len(values[i]) > len(values[j])
	})
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, regexp.QuoteMeta(value))
	}
	literalRE := regexp.MustCompile(strings.Join(quoted, "|"))

	state := markdownLiteralFenceState{}
	lines := strings.SplitAfter(text, "\n")
	for index, line := range lines {
		if state.delimiter == "" {
			if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
				state = opening
			}
			continue
		}
		if !continuesMarkdownLiteralFenceContainer(line, state) {
			state = markdownLiteralFenceState{}
			if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
				state = opening
			}
			continue
		}
		if isMarkdownLiteralFenceClosing(line, state) {
			state = markdownLiteralFenceState{}
			continue
		}
		lines[index] = maskMatches(line, literalRE, nextPlaceholder, placeholders, mapping)
	}
	return strings.Join(lines, "")
}

func maskMatches(text string, re *regexp.Regexp, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	matches := re.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	pos := 0
	for _, span := range matches {
		start, end := span[0], span[1]
		if start < pos {
			continue
		}
		out.WriteString(text[pos:start])
		placeholder := nextPlaceholder()
		mapping[placeholder] = text[start:end]
		*placeholders = append(*placeholders, placeholder)
		out.WriteString(placeholder)
		pos = end
	}
	out.WriteString(text[pos:])
	return out.String()
}

func maskLinkURLs(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	matches := linkURLRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	pos := 0
	for _, span := range matches {
		fullStart := span[0]
		urlStart, urlEnd := span[2], span[3]
		if urlStart < 0 || urlEnd < 0 {
			continue
		}
		if fullStart < pos {
			continue
		}
		out.WriteString(text[pos:urlStart])
		placeholder := nextPlaceholder()
		mapping[placeholder] = text[urlStart:urlEnd]
		*placeholders = append(*placeholders, placeholder)
		out.WriteString(placeholder)
		pos = urlEnd
	}
	out.WriteString(text[pos:])
	return out.String()
}

func unmaskMarkdown(text string, placeholders []string, mapping map[string]string) string {
	out := text
	for _, placeholder := range placeholders {
		original := mapping[placeholder]
		out = strings.ReplaceAll(out, placeholder, original)
	}
	return out
}

func validatePlaceholders(text string, placeholders []string) error {
	for _, placeholder := range placeholders {
		count := strings.Count(text, placeholder)
		if count == 0 {
			return fmt.Errorf("placeholder missing: %s", placeholder)
		}
		if count != 1 {
			return fmt.Errorf("placeholder duplicated: %s count=%d", placeholder, count)
		}
	}
	return nil
}

func placeholdersInText(text string, placeholders []string) []string {
	found := make([]string, 0, len(placeholders))
	for _, placeholder := range placeholders {
		if strings.Contains(text, placeholder) {
			found = append(found, placeholder)
		}
	}
	return found
}
