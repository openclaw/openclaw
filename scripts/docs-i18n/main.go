package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type docJob struct {
	index int
	path  string
	rel   string
}

type docResult struct {
	index    int
	rel      string
	duration time.Duration
	skipped  bool
	err      error
}

func main() {
	var (
		targetLang = flag.String("lang", "zh-CN", "target language (e.g., zh-CN)")
		sourceLang = flag.String("src", "en", "source language")
		docsRoot   = flag.String("docs", "docs", "docs root")
		tmPath     = flag.String("tm", "", "translation memory path")
		mode       = flag.String("mode", "segment", "translation mode (segment|doc)")
		thinking   = flag.String("thinking", "high", "thinking level (low|high)")
		overwrite  = flag.Bool("overwrite", false, "overwrite existing translations")
		maxFiles   = flag.Int("max", 0, "max files to process (0 = all)")
		parallel   = flag.Int("parallel", 1, "parallel workers for doc mode")
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

	translator, err := NewPiTranslator(*sourceLang, *targetLang, glossary, *thinking)
	if err != nil {
		fatal(err)
	}
	defer translator.Close()

	tm, err := LoadTranslationMemory(*tmPath)
	if err != nil {
		fatal(err)
	}

	ordered, err := orderFiles(resolvedDocsRoot, files)
	if err != nil {
		fatal(err)
	}
	totalFiles := len(ordered)
	preSkipped := 0
	if *mode == "doc" && !*overwrite {
		filtered, skipped, err := filterDocQueue(resolvedDocsRoot, *targetLang, ordered)
		if err != nil {
			fatal(err)
		}
		ordered = filtered
		preSkipped = skipped
	}
	if *maxFiles > 0 && *maxFiles < len(ordered) {
		ordered = ordered[:*maxFiles]
	}

	log.SetFlags(log.LstdFlags)
	start := time.Now()
	processed := 0
	skipped := 0

	if *parallel < 1 {
		*parallel = 1
	}

	log.Printf("docs-i18n: mode=%s total=%d pending=%d pre_skipped=%d overwrite=%t thinking=%s parallel=%d", *mode, totalFiles, len(ordered), preSkipped, *overwrite, *thinking, *parallel)
	switch *mode {
	case "doc":
		if *parallel > 1 {
			proc, skip, err := runDocParallel(context.Background(), ordered, resolvedDocsRoot, *sourceLang, *targetLang, *overwrite, *parallel, glossary, *thinking)
			if err != nil {
				fatal(err)
			}
			processed += proc
			skipped += skip
		} else {
			proc, skip, err := runDocSequential(context.Background(), ordered, translator, resolvedDocsRoot, *sourceLang, *targetLang, *overwrite)
			if err != nil {
				fatal(err)
			}
			processed += proc
			skipped += skip
		}
	case "segment":
		if *parallel > 1 {
			fatal(fmt.Errorf("parallel processing is only supported in doc mode"))
		}
		proc, err := runSegmentSequential(context.Background(), ordered, translator, tm, resolvedDocsRoot, *sourceLang, *targetLang)
		if err != nil {
			fatal(err)
		}
		processed += proc
	default:
		fatal(fmt.Errorf("unknown mode: %s", *mode))
	}

	if err := tm.Save(); err != nil {
		fatal(err)
	}
	elapsed := time.Since(start).Round(time.Millisecond)
	log.Printf("docs-i18n: completed processed=%d skipped=%d elapsed=%s", processed, skipped, elapsed)
}

func runDocSequential(ctx context.Context, ordered []string, translator *PiTranslator, docsRoot, srcLang, tgtLang string, overwrite bool) (int, int, error) {
	processed := 0
	skipped := 0
	for index, file := range ordered {
		relPath := resolveRelPath(docsRoot, file)
		log.Printf("docs-i18n: [%d/%d] start %s", index+1, len(ordered), relPath)
		start := time.Now()
		skip, err := processFileDoc(ctx, translator, docsRoot, file, srcLang, tgtLang, overwrite)
		if err != nil {
			return processed, skipped, err
		}
		if skip {
			skipped++
			log.Printf("docs-i18n: [%d/%d] skipped %s (%s)", index+1, len(ordered), relPath, time.Since(start).Round(time.Millisecond))
		} else {
			processed++
			log.Printf("docs-i18n: [%d/%d] done %s (%s)", index+1, len(ordered), relPath, time.Since(start).Round(time.Millisecond))
		}
	}
	return processed, skipped, nil
}

func runDocParallel(ctx context.Context, ordered []string, docsRoot, srcLang, tgtLang string, overwrite bool, parallel int, glossary []GlossaryEntry, thinking string) (int, int, error) {
	jobs := make(chan docJob)
	results := make(chan docResult, len(ordered))
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	for worker := 0; worker < parallel; worker++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			translator, err := NewPiTranslator(srcLang, tgtLang, glossary, thinking)
			if err != nil {
				results <- docResult{err: err}
				return
			}
			defer translator.Close()
			for job := range jobs {
				if ctx.Err() != nil {
					return
				}
				log.Printf("docs-i18n: [w%d %d/%d] start %s", workerID, job.index, len(ordered), job.rel)
				start := time.Now()
				skip, err := processFileDoc(ctx, translator, docsRoot, job.path, srcLang, tgtLang, overwrite)
				results <- docResult{
					index:    job.index,
					rel:      job.rel,
					duration: time.Since(start),
					skipped:  skip,
					err:      err,
				}
				if err != nil {
					cancel()
					return
				}
			}
		}(worker + 1)
	}

	go func() {
		for index, file := range ordered {
			jobs <- docJob{index: index + 1, path: file, rel: resolveRelPath(docsRoot, file)}
		}
		close(jobs)
	}()

	processed := 0
	skipped := 0
	for i := 0; i < len(ordered); i++ {
		result := <-results
		if result.err != nil {
			wg.Wait()
			return processed, skipped, result.err
		}
		if result.skipped {
			skipped++
			log.Printf("docs-i18n: [w* %d/%d] skipped %s (%s)", result.index, len(ordered), result.rel, result.duration.Round(time.Millisecond))
		} else {
			processed++
			log.Printf("docs-i18n: [w* %d/%d] done %s (%s)", result.index, len(ordered), result.rel, result.duration.Round(time.Millisecond))
		}
	}
	wg.Wait()
	return processed, skipped, nil
}

func runSegmentSequential(ctx context.Context, ordered []string, translator *PiTranslator, tm *TranslationMemory, docsRoot, srcLang, tgtLang string) (int, error) {
	processed := 0
	for index, file := range ordered {
		relPath := resolveRelPath(docsRoot, file)
		log.Printf("docs-i18n: [%d/%d] start %s", index+1, len(ordered), relPath)
		start := time.Now()
		if _, err := processFile(ctx, translator, tm, docsRoot, file, srcLang, tgtLang); err != nil {
			return processed, err
		}
		processed++
		log.Printf("docs-i18n: [%d/%d] done %s (%s)", index+1, len(ordered), relPath, time.Since(start).Round(time.Millisecond))
	}
	return processed, nil
}

func resolveRelPath(docsRoot, file string) string {
	relPath := file
	if _, rel, err := resolveDocsPath(docsRoot, file); err == nil {
		relPath = rel
	}
	return relPath
}

func filterDocQueue(docsRoot, targetLang string, ordered []string) ([]string, int, error) {
	pending := make([]string, 0, len(ordered))
	skipped := 0
	for _, file := range ordered {
		absPath, relPath, err := resolveDocsPath(docsRoot, file)
		if err != nil {
			return nil, skipped, err
		}
		content, err := os.ReadFile(absPath)
		if err != nil {
			return nil, skipped, err
		}
		sourceHash := hashBytes(content)
		outputPath := filepath.Join(docsRoot, targetLang, relPath)
		skip, err := shouldSkipDoc(outputPath, sourceHash)
		if err != nil {
			return nil, skipped, err
		}
		if skip {
			skipped++
			continue
		}
		pending = append(pending, file)
	}
	return pending, skipped, nil
}
