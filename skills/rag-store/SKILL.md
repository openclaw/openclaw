---
name: rag-store
description: "Local RAG (Retrieval-Augmented Generation) with ChromaDB vector store. Ingest books, documents, PDFs, and text files, then answer questions using semantic search. Use when user wants to add knowledge or ask questions about their documents. NOT for: structured data with tables (use local-db), real-time web search, or editing documents."
metadata:
  {
    "openclaw":
      {
        "emoji": "📚",
        "requires": { "bins": ["python3"] },
        "install":
          [
            {
              "id": "pip-chromadb",
              "kind": "pip",
              "package": "chromadb",
              "label": "Install ChromaDB (pip)",
            },
          ],
      },
  }
---

# RAG Store (ChromaDB)

Manage a local RAG vector store via the bundled `ragstore.py` script. Uses ChromaDB with built-in embeddings (no API key needed). Data stored in `~/.openclaw/ragstore/`.

## When to use

✅ **USE this skill when:**

- User says "add this book/document to my knowledge base"
- User asks "what does [book/document] say about X?"
- User wants to search across documents semantically
- User says "I want to ask questions about this PDF/file"
- User mentions RAG, vector search, or knowledge base

## When NOT to use

❌ **DON'T use this skill when:**

- User wants structured data with tables/relationships → use local-db
- User wants to store key-value pairs or config → use files/JSON
- User needs real-time web search → use browser or search tools
- User wants to edit or modify the original document → use file tools
- Document is very small (< 100 words) → just read the file directly

## Commands

### Add a document to a collection

```bash
# Add a text/markdown file
python3 {baseDir}/scripts/ragstore.py add ~/Documents/my-book.txt -c books

# Add a PDF (requires poppler-utils: apt install poppler-utils)
python3 {baseDir}/scripts/ragstore.py add ~/Documents/paper.pdf -c research

# Custom chunk settings
python3 {baseDir}/scripts/ragstore.py add ~/Documents/large-book.txt -c books --chunk-size 300 --overlap 30
```

### Query the knowledge base

```bash
# Ask a question (returns top 5 relevant chunks)
python3 {baseDir}/scripts/ragstore.py query "What are the main principles of stoicism?" -c books

# More results
python3 {baseDir}/scripts/ragstore.py query "How to treat lower back pain?" -c medical -k 10

# JSON output (for programmatic use)
python3 {baseDir}/scripts/ragstore.py query "What is the treatment protocol?" -c medical --json
```

### List collections

```bash
python3 {baseDir}/scripts/ragstore.py collections
```

### List ingested documents in a collection

```bash
python3 {baseDir}/scripts/ragstore.py sources -c books
```

### Remove a document from a collection

```bash
python3 {baseDir}/scripts/ragstore.py remove-source "my-book.txt" -c books
```

### Delete a collection entirely

```bash
python3 {baseDir}/scripts/ragstore.py delete-collection old-collection
```

## Supported file formats

| Format     | Extension                   | Requirement                                 |
| ---------- | --------------------------- | ------------------------------------------- |
| Plain text | .txt, .md, .rst, .csv, .log | Built-in                                    |
| PDF        | .pdf                        | `poppler-utils` (apt install poppler-utils) |
| EPUB       | .epub                       | `calibre` (apt install calibre)             |
| JSON       | .json                       | Built-in                                    |

## How it works

1. **Ingest**: Document is split into overlapping chunks (default: 500 words, 50 overlap)
2. **Embed**: ChromaDB generates embeddings using its default model (all-MiniLM-L6-v2, runs locally)
3. **Store**: Chunks + metadata stored in persistent ChromaDB at `~/.openclaw/ragstore/`
4. **Query**: Question is embedded and compared against stored chunks using cosine similarity
5. **Return**: Top-K most relevant chunks returned with source info and distance score

## Workflow for answering user questions

When the user asks about document content:

1. Use `python3 {baseDir}/scripts/ragstore.py query "<question>" -c <collection> --json` to get relevant chunks
2. Read the returned chunks
3. Synthesize an answer using the chunk content as context
4. Cite the source document and chunk index

## Collections pattern

Organize knowledge by topic:

- `books` — General reading
- `medical` — Medical literature
- `work` — Work-related documents
- `personal` — Personal notes/documents
- `research` — Academic papers

## Tips

- Smaller chunk sizes (200-300) work better for precise Q&A
- Larger chunk sizes (500-800) work better for summaries
- The first query in a new session may be slow (model loading)
- ChromaDB uses ~200MB for the default embedding model (downloaded on first use)
