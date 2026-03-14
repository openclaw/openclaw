#!/usr/bin/env python3
"""
ragstore — CLI for managing a local RAG (Retrieval-Augmented Generation) store.
OpenClaw skill: lets the agent ingest documents (books, PDFs, text files)
into a ChromaDB vector store and query them semantically.
"""
import argparse
import hashlib
import json
import os
import re
import sys

STORE_DIR = os.path.expanduser("~/.openclaw/ragstore")


def get_client(collection_name="default"):
    try:
        import chromadb
    except ImportError:
        print("Error: chromadb not installed. Run: pip3 install chromadb", file=sys.stderr)
        sys.exit(1)

    os.makedirs(STORE_DIR, exist_ok=True)
    client = chromadb.PersistentClient(path=STORE_DIR)
    return client


def chunk_text(text, chunk_size=500, overlap=50):
    """Split text into overlapping chunks by words."""
    if overlap < 0:
        print(f"Error: overlap ({overlap}) must be non-negative.", file=sys.stderr)
        sys.exit(1)
    if overlap >= chunk_size:
        print(f"Error: overlap ({overlap}) must be less than chunk_size ({chunk_size}).", file=sys.stderr)
        sys.exit(1)
    words = text.split()
    if not words:
        return []
    chunks = []
    start = 0
    while start < len(words):
        end = start + chunk_size
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end >= len(words):
            break
        start = end - overlap
    return chunks


def extract_text_from_file(filepath):
    """Extract text from various file formats."""
    ext = os.path.splitext(filepath)[1].lower()

    if ext == ".pdf":
        try:
            import subprocess  # nosec B404
            result = subprocess.run(  # nosec B603 B607
                ["pdftotext", filepath, "-"],
                capture_output=True, text=True, timeout=60
            )
            if result.returncode == 0:
                return result.stdout
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        print(f"Warning: pdftotext not available. Install poppler-utils.", file=sys.stderr)
        return None

    elif ext in (".txt", ".md", ".rst", ".csv", ".log", ".json"):
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    elif ext in (".epub",):
        try:
            import subprocess  # nosec B404
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
                tmp_path = tmp.name
            result = subprocess.run(  # nosec B603 B607
                ["ebook-convert", filepath, tmp_path],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode == 0:
                with open(tmp_path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
                os.unlink(tmp_path)
                return text
            os.unlink(tmp_path)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            if 'tmp_path' in locals():
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
        print(f"Warning: ebook-convert not available. Install calibre.", file=sys.stderr)
        return None

    else:
        # Try as plain text
        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception:
            print(f"Cannot read file: {filepath}", file=sys.stderr)
            return None


def validate_collection_name(name):
    """Validate collection name to prevent path traversal or injection."""
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        print(f"Error: invalid collection name '{name}'. Use only alphanumeric, _ and -.", file=sys.stderr)
        sys.exit(1)
    return name


def cmd_collections(args):
    client = get_client()
    cols = client.list_collections()
    if not cols:
        print("No collections. Create one with: ragstore add -c <name> <file>")
        return
    for c in cols:
        col = client.get_collection(c.name)
        count = col.count()
        print(f"  {c.name}  ({count} chunks)")


def cmd_add(args):
    validate_collection_name(args.collection)
    client = get_client()
    collection = client.get_or_create_collection(
        name=args.collection,
        metadata={"hnsw:space": "cosine"}
    )

    filepath = os.path.expanduser(args.file)
    if not os.path.exists(filepath):
        print(f"File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    text = extract_text_from_file(filepath)
    if not text or len(text.strip()) == 0:
        print(f"No text extracted from: {filepath}", file=sys.stderr)
        sys.exit(1)

    filename = os.path.basename(filepath)
    chunks = chunk_text(text, chunk_size=args.chunk_size, overlap=args.overlap)

    print(f"Ingesting '{filename}' into collection '{args.collection}'...")
    print(f"  Text length: {len(text)} chars")
    print(f"  Chunks: {len(chunks)}")

    ids = []
    documents = []
    metadatas = []

    resolved_path = os.path.realpath(filepath)
    for i, chunk in enumerate(chunks):
        doc_id = hashlib.md5(f"{resolved_path}:{i}".encode(), usedforsecurity=False).hexdigest()  # nosec B324
        ids.append(doc_id)
        documents.append(chunk)
        metadatas.append({
            "source": filename,
            "source_path": resolved_path,
            "chunk_index": i,
            "total_chunks": len(chunks),
        })

    # Add in batches of 100
    batch_size = 100
    for start in range(0, len(ids), batch_size):
        end = min(start + batch_size, len(ids))
        collection.upsert(
            ids=ids[start:end],
            documents=documents[start:end],
            metadatas=metadatas[start:end],
        )

    # Remove stale chunks from previous ingestion of the same file
    # (e.g. file was shortened and now has fewer chunks)
    stale_ids = []
    idx = len(chunks)
    while True:
        old_id = hashlib.md5(f"{resolved_path}:{idx}".encode(), usedforsecurity=False).hexdigest()  # nosec B324
        existing = collection.get(ids=[old_id])
        if not existing["ids"]:
            break
        stale_ids.append(old_id)
        idx += 1
    if stale_ids:
        collection.delete(ids=stale_ids)
        print(f"  Removed {len(stale_ids)} stale chunks from previous ingestion.")

    print(f"Done. Total chunks in collection: {collection.count()}")


def cmd_query(args):
    validate_collection_name(args.collection)
    client = get_client()
    try:
        collection = client.get_collection(args.collection)
    except Exception:
        print(f"Collection '{args.collection}' not found.", file=sys.stderr)
        sys.exit(1)

    results = collection.query(
        query_texts=[args.question],
        n_results=args.top_k,
    )

    if not results["documents"] or not results["documents"][0]:
        print("No results found.")
        return

    if args.json_output:
        output = []
        for i, doc in enumerate(results["documents"][0]):
            meta = results["metadatas"][0][i] if results["metadatas"] else {}
            dist = results["distances"][0][i] if results["distances"] else None
            output.append({
                "rank": i + 1,
                "source": meta.get("source", "unknown"),
                "chunk_index": meta.get("chunk_index"),
                "distance": dist,
                "text": doc,
            })
        print(json.dumps(output, indent=2))
    else:
        for i, doc in enumerate(results["documents"][0]):
            meta = results["metadatas"][0][i] if results["metadatas"] else {}
            dist = results["distances"][0][i] if results["distances"] else None
            source = meta.get("source", "unknown")
            chunk_idx = meta.get("chunk_index", "?")
            score = f" (distance: {dist:.4f})" if dist is not None else ""
            print(f"\n--- Result {i+1} [{source} chunk {chunk_idx}]{score} ---")
            print(doc[:500])
            if len(doc) > 500:
                print(f"  ... ({len(doc)} chars total)")


def cmd_sources(args):
    validate_collection_name(args.collection)
    client = get_client()
    try:
        collection = client.get_collection(args.collection)
    except Exception:
        print(f"Collection '{args.collection}' not found.", file=sys.stderr)
        sys.exit(1)

    all_data = collection.get(include=["metadatas"])
    sources = {}
    for meta in all_data["metadatas"]:
        key = meta.get("source_path") or meta.get("source", "unknown")
        total = meta.get("total_chunks", 1)
        sources[key] = total

    if not sources:
        print("No documents in this collection.")
        return

    for src, chunks in sorted(sources.items()):
        print(f"  {src}  ({chunks} chunks)")


def cmd_delete_collection(args):
    validate_collection_name(args.collection)
    client = get_client()
    try:
        client.delete_collection(args.collection)
        print(f"Collection '{args.collection}' deleted.")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_remove_source(args):
    validate_collection_name(args.collection)
    client = get_client()
    try:
        collection = client.get_collection(args.collection)
    except Exception:
        print(f"Collection '{args.collection}' not found.", file=sys.stderr)
        sys.exit(1)

    all_data = collection.get(include=["metadatas"])
    source_basename = os.path.basename(args.source)
    resolved_source = os.path.realpath(args.source)
    # Basename fallback only when user passed a bare filename (no directory part),
    # to avoid removing chunks from different files with the same basename.
    is_bare_name = os.sep not in args.source and '/' not in args.source
    ids_to_remove = []
    for i, meta in enumerate(all_data["metadatas"]):
        stored_path = meta.get("source_path", "")
        stored_name = meta.get("source", "")
        if (
            stored_path == resolved_source
            or stored_name == args.source
            or (is_bare_name and stored_name == source_basename)
        ):
            ids_to_remove.append(all_data["ids"][i])

    if not ids_to_remove:
        print(f"No chunks from source '{args.source}' found.")
        return

    collection.delete(ids=ids_to_remove)
    print(f"Removed {len(ids_to_remove)} chunks from source '{args.source}'.")


def main():
    parser = argparse.ArgumentParser(
        prog="ragstore",
        description="Local RAG vector store for OpenClaw (ChromaDB)"
    )
    sub = parser.add_subparsers(dest="command")

    # collections
    sub.add_parser("collections", help="List all collections")

    # add
    p = sub.add_parser("add", help="Ingest a document into a collection")
    p.add_argument("file", help="Path to document (txt, md, pdf, epub, etc.)")
    p.add_argument("-c", "--collection", default="default", help="Collection name (default: 'default')")
    p.add_argument("--chunk-size", type=int, default=500, help="Words per chunk (default: 500)")
    p.add_argument("--overlap", type=int, default=50, help="Overlap words between chunks (default: 50)")

    # query
    p = sub.add_parser("query", help="Semantic search in a collection")
    p.add_argument("question", help="Natural language question")
    p.add_argument("-c", "--collection", default="default", help="Collection name")
    p.add_argument("-k", "--top-k", type=int, default=5, help="Number of results (default: 5)")
    p.add_argument("--json", dest="json_output", action="store_true", help="Output as JSON")

    # sources
    p = sub.add_parser("sources", help="List ingested documents in a collection")
    p.add_argument("-c", "--collection", default="default", help="Collection name")

    # delete-collection
    p = sub.add_parser("delete-collection", help="Delete a collection")
    p.add_argument("collection", help="Collection name to delete")

    # remove-source
    p = sub.add_parser("remove-source", help="Remove a document source from a collection")
    p.add_argument("source", help="Source filename to remove")
    p.add_argument("-c", "--collection", default="default", help="Collection name")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    cmds = {
        "collections": cmd_collections,
        "add": cmd_add,
        "query": cmd_query,
        "sources": cmd_sources,
        "delete-collection": cmd_delete_collection,
        "remove-source": cmd_remove_source,
    }
    cmds[args.command](args)


if __name__ == "__main__":
    main()
