package main

import (
	"os"
)

func postprocessLocalizedDocs(docsRoot, targetLang string, localizedFiles []string) error {
	if targetLang == "" || targetLang == "en" || len(localizedFiles) == 0 {
		return nil
	}

	routes, err := loadRouteIndex(docsRoot, targetLang)
	if err != nil {
		return err
	}

	for _, path := range localizedFiles {
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		frontMatter, body := splitFrontMatter(string(content))
		rewrittenBody := routes.localizeBodyLinks(body)
		if rewrittenBody == body {
			continue
		}

		output := rewrittenBody
		if frontMatter != "" {
			output = "---\n" + frontMatter + "\n---\n\n" + rewrittenBody
		}

		if err := os.WriteFile(path, []byte(output), 0o644); err != nil {
			return err
		}
	}

	return nil
}
