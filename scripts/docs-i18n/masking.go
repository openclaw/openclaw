package main

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	inlineCodeRe     = regexp.MustCompile("`[^`]+`")
	angleLinkRe      = regexp.MustCompile(`<https?://[^>]+>`)
	linkURLRe        = regexp.MustCompile(`\[[^\]]*\]\(([^)]+)\)`)
	jsxAttributeRe   = regexp.MustCompile(`\s(href|src|action)=["'](/[^"']+)["']`)
	placeholderRe    = regexp.MustCompile(`__OC_I18N_\d+__`)
)

func maskMarkdown(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	masked := maskMatches(text, inlineCodeRe, nextPlaceholder, placeholders, mapping)
	masked = maskMatches(masked, angleLinkRe, nextPlaceholder, placeholders, mapping)
	masked = maskLinkURLs(masked, nextPlaceholder, placeholders, mapping)
	masked = maskJSXAttributes(masked, nextPlaceholder, placeholders, mapping)
	return masked
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

func unmaskMarkdown(text string, placeholders []string, mapping map[string]string, tgtLang string) string {
	out := text
	for _, placeholder := range placeholders {
		original := mapping[placeholder]
		// Add locale prefix for non-English targets if it's an internal link
		if tgtLang != "" && tgtLang != "en" && strings.HasPrefix(original, "/") && !strings.HasPrefix(original, "/"+tgtLang+"/") && !strings.HasPrefix(original, "/"+tgtLang) {
			original = "/" + tgtLang + original
		}
		out = strings.ReplaceAll(out, placeholder, original)
	}
	return out
}

func maskJSXAttributes(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	matches := jsxAttributeRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	pos := 0
	for _, match := range matches {
		if len(match) < 4 {
			continue
		}
		start, end := match[0], match[1]
		fullMatch := text[start:end]
		attrStart, attrEnd := match[2], match[3]
		attrValue := text[start+attrStart : start+attrEnd]
		if start < pos {
			continue
		}
		out.WriteString(text[pos:start])
		placeholder := nextPlaceholder()
		mapping[placeholder] = attrValue
		*placeholders = append(*placeholders, placeholder)
		out.WriteString(fullMatch[:attrStart])
		out.WriteString(placeholder)
		out.WriteString(fullMatch[attrEnd-start:])
		pos = end
	}
	out.WriteString(text[pos:])
	return out.String()
}

func validatePlaceholders(text string, placeholders []string) error {
	for _, placeholder := range placeholders {
		if !strings.Contains(text, placeholder) {
			return fmt.Errorf("placeholder missing: %s", placeholder)
		}
	}
	return nil
}
