package main

import (
	"os"
	"path/filepath"
)

func postprocessLocalizedDocs(docsRoot, targetLang string) error {
	if targetLang == "" || targetLang == "en" {
		return nil
	}

	routes, err := loadRouteIndex(docsRoot, targetLang)
	if err != nil {
		return err
	}

	localeRoot := filepath.Join(docsRoot, targetLang)
	if _, err := os.Stat(localeRoot); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	return filepath.WalkDir(localeRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !isMarkdownFile(path) {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		frontMatter, body := splitFrontMatter(string(content))
		rewrittenBody := routes.localizeBodyLinks(body)
		if rewrittenBody == body {
			return nil
		}

		output := rewrittenBody
		if frontMatter != "" {
			output = "---\n" + frontMatter + "---\n\n" + rewrittenBody
		}

		return os.WriteFile(path, []byte(output), 0o644)
	})
}
