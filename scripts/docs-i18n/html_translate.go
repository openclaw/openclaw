package main

import (
	"context"
	"io"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"golang.org/x/net/html"
)

func translateHTMLBlocks(ctx context.Context, translator docsTranslator, body, srcLang, tgtLang string) (string, error) {
	source := []byte(body)
	r := text.NewReader(source)
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
	)
	doc := md.Parser().Parse(r)

	replacements := make([]Segment, 0, 8)

	err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		block, ok := n.(*ast.HTMLBlock)
		if !ok {
			return ast.WalkContinue, nil
		}
		start, stop, ok := htmlBlockSpan(block)
		if !ok {
			return ast.WalkSkipChildren, nil
		}
		htmlText := string(source[start:stop])
		translated, err := translateHTMLBlock(ctx, translator, htmlText, srcLang, tgtLang)
		if err != nil {
			return ast.WalkStop, err
		}
		replacements = append(replacements, Segment{Start: start, Stop: stop, Translated: translated})
		return ast.WalkSkipChildren, nil
	})

	if err != nil {
		return "", err
	}
	sort.Slice(replacements, func(i, j int) bool {
		return replacements[i].Start < replacements[j].Start
	})
	return applyTranslations(body, replacements), nil
}

func htmlBlockSpan(block *ast.HTMLBlock) (int, int, bool) {
	lines := block.Lines()
	if lines.Len() == 0 {
		return 0, 0, false
	}
	start := lines.At(0).Start
	stop := lines.At(lines.Len() - 1).Stop
	return start, stop, start < stop
}

func translateHTMLBlock(ctx context.Context, translator docsTranslator, htmlText, srcLang, tgtLang string) (string, error) {
	tokenizer := html.NewTokenizer(strings.NewReader(htmlText))
	var out strings.Builder
	skipDepth := 0

	for {
		tt := tokenizer.Next()
		if tt == html.ErrorToken {
			if err := tokenizer.Err(); err != nil && err != io.EOF {
				return "", err
			}
			break
		}

		raw := string(tokenizer.Raw())
		tok := tokenizer.Token()

		switch tt {
		case html.StartTagToken:
			out.WriteString(raw)
			if isSkipTag(strings.ToLower(tok.Data)) {
				skipDepth++
			}
		case html.EndTagToken:
			out.WriteString(raw)
			if isSkipTag(strings.ToLower(tok.Data)) && skipDepth > 0 {
				skipDepth--
			}
		case html.TextToken:
			if shouldTranslateHTMLText(skipDepth, raw) {
				translated, err := translator.Translate(ctx, raw, srcLang, tgtLang)
				if err != nil {
					return "", err
				}
				out.WriteString(translated)
			} else {
				out.WriteString(raw)
			}
		default:
			out.WriteString(raw)
		}
	}

	return out.String(), nil
}

func shouldTranslateHTMLText(skipDepth int, text string) bool {
	return skipDepth == 0 && strings.TrimSpace(text) != ""
}

func isSkipTag(tag string) bool {
	switch tag {
	case "code", "pre", "script", "style":
		return true
	default:
		return false
	}
}
