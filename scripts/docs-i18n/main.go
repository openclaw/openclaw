package main

import (
	"context"
	"flag"
	"fmt"
	"path/filepath"
)

func main() {
	var (
		targetLang = flag.String("lang", "zh-CN", "target language (e.g., zh-CN)")
		sourceLang = flag.String("src", "en", "source language")
		docsRoot   = flag.String("docs", "docs", "docs root")
		tmPath     = flag.String("tm", "", "translation memory path")
	)
	flag.Parse()
	files := flag.Args()
	if len(files) == 0 {
		fatal(fmt.Errorf("no doc files provided"))
	}

	resolvedDocsRoot, err := filepath.Abs(*docsRoot)
	if err != nil {
		fatal(err)
	}

	if *tmPath == "" {
		*tmPath = filepath.Join(resolvedDocsRoot, ".i18n", fmt.Sprintf("%s.tm.jsonl", *targetLang))
	}

	glossaryPath := filepath.Join(resolvedDocsRoot, ".i18n", fmt.Sprintf("glossary.%s.json", *targetLang))
	glossary, err := LoadGlossary(glossaryPath)
	if err != nil {
		fatal(err)
	}

	translator, err := NewPiTranslator(*sourceLang, *targetLang, glossary)
	if err != nil {
		fatal(err)
	}
	defer translator.Close()

	tm, err := LoadTranslationMemory(*tmPath)
	if err != nil {
		fatal(err)
	}

	for _, file := range files {
		if err := processFile(context.Background(), translator, tm, resolvedDocsRoot, file, *sourceLang, *targetLang); err != nil {
			fatal(err)
		}
	}

	if err := tm.Save(); err != nil {
		fatal(err)
	}
}
