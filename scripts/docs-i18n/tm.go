package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type TMEntry struct {
	CacheKey   string `json:"cache_key"`
	SegmentID  string `json:"segment_id"`
	SourcePath string `json:"source_path"`
	TextHash   string `json:"text_hash"`
	Text       string `json:"text"`
	Translated string `json:"translated"`
	SrcLang    string `json:"src_lang"`
	TgtLang    string `json:"tgt_lang"`
	UpdatedAt  string `json:"updated_at"`
}

type TranslationMemory struct {
	path    string
	entries map[string]TMEntry
}

func LoadTranslationMemory(path string) (*TranslationMemory, error) {
	tm := &TranslationMemory{path: path, entries: map[string]TMEntry{}}
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return tm, nil
		}
		return nil, err
	}
	defer file.Close()

	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := strings.TrimSpace(string(line))
			if trimmed != "" {
				var entry TMEntry
				if err := json.Unmarshal([]byte(trimmed), &entry); err != nil {
					return nil, fmt.Errorf("translation memory decode failed: %w", err)
				}
				if entry.CacheKey != "" && strings.TrimSpace(entry.Translated) != "" {
					tm.entries[entry.CacheKey] = entry
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
	}
	return tm, nil
}

func (tm *TranslationMemory) Get(cacheKey string) (TMEntry, bool) {
	entry, ok := tm.entries[cacheKey]
	if !ok || strings.TrimSpace(entry.Translated) == "" {
		return TMEntry{}, false
	}
	return entry, true
}

func (tm *TranslationMemory) Put(entry TMEntry) {
	if entry.CacheKey == "" {
		return
	}
	tm.entries[entry.CacheKey] = entry
}

func (tm *TranslationMemory) Save() error {
	if tm.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(tm.path), 0o755); err != nil {
		return err
	}
	tmpPath := tm.path + ".tmp"
	file, err := os.Create(tmpPath)
	if err != nil {
		return err
	}

	writer := bufio.NewWriter(file)
	encoder := json.NewEncoder(writer)
	for _, key := range slices.Sorted(maps.Keys(tm.entries)) {
		if err := encoder.Encode(tm.entries[key]); err != nil {
			_ = file.Close()
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, tm.path)
}
