package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTranslationMemorySavePreservesJSONL(t *testing.T) {
	t.Parallel()
	file := filepath.Join(t.TempDir(), "memory.jsonl")
	memory, err := LoadTranslationMemory(file)
	if err != nil {
		t.Fatal(err)
	}
	memory.Put(TMEntry{CacheKey: "z", Text: "<tag>\n&", Translated: "日本語\u2028"})
	memory.Put(TMEntry{CacheKey: "a", Translated: "first"})
	if err := memory.Save(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"cache_key":"a","segment_id":"","source_path":"","text_hash":"","text":"","translated":"first","src_lang":"","tgt_lang":"","updated_at":""}` + "\n" +
		`{"cache_key":"z","segment_id":"","source_path":"","text_hash":"","text":"\u003ctag\u003e\n\u0026","translated":"日本語\u2028","src_lang":"","tgt_lang":"","updated_at":""}` + "\n"
	if string(data) != want {
		t.Fatalf("translation memory bytes changed:\n%s", data)
	}
	reloaded, err := LoadTranslationMemory(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"a", "z"} {
		want, _ := memory.Get(key)
		if got, ok := reloaded.Get(key); !ok || got != want {
			t.Fatalf("translation memory entry %q did not round trip: %+v", key, got)
		}
	}
}
