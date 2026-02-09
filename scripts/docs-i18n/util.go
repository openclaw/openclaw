package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	workflowVersion = 15
	providerName    = "pi"
	modelVersion    = "claude-opus-4-6"
)

func cacheNamespace() string {
	return fmt.Sprintf("wf=%d|provider=%s|model=%s", workflowVersion, providerName, modelVersion)
}

func cacheKey(namespace, srcLang, tgtLang, segmentID, textHash string) string {
	raw := fmt.Sprintf("%s|%s|%s|%s|%s", namespace, srcLang, tgtLang, segmentID, textHash)
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}

func hashText(text string) string {
	normalized := normalizeText(text)
	hash := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(hash[:])
}

func hashBytes(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func normalizeText(text string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
}

func segmentID(relPath, textHash string) string {
	shortHash := textHash
	if len(shortHash) > 16 {
		shortHash = shortHash[:16]
	}
	return fmt.Sprintf("%s:%s", relPath, shortHash)
}

func splitWhitespace(text string) (string, string, string) {
	if text == "" {
		return "", "", ""
	}
	start := 0
	for start < len(text) && isWhitespace(text[start]) {
		start++
	}
	end := len(text)
	for end > start && isWhitespace(text[end-1]) {
		end--
	}
	return text[:start], text[start:end], text[end:]
}

func isWhitespace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r':
		return true
	default:
		return false
	}
}

func fatal(err error) {
	if err == nil {
		return
	}
	_, _ = io.WriteString(os.Stderr, err.Error()+"\n")
	os.Exit(1)
}
