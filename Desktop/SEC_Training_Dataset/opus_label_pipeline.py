#!/usr/bin/env python3
"""
Opus Label Pipeline — Convert Opus entity annotations to training JSONL.

Workflow:
  1. Opus reads contract headers/signatures, identifies unique entities
  2. This script resolves all occurrences with character offsets
  3. Regex detects deterministic types (EMAIL, PHONE, DATE, MONEY, SSN, etc.)
  4. Outputs chunked JSONL ready for DeBERTa training

Input: opus_annotations.jsonl — one line per doc:
  {"doc": "mer_01", "orgs": ["Aventis Inc.", ...], "persons": ["John Smith", ...],
   "addresses": ["123 Main St, City, ST 12345", ...]}

Output: opus_labeled_training.jsonl — same format as augmented_training.jsonl
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

TXT_DIR = Path("/Users/donniedarko/Desktop/SEC_Training_Dataset/TXT")
ANNOTATIONS_PATH = Path("/Users/donniedarko/Desktop/SEC_Training_Dataset/opus_annotations.jsonl")
OUTPUT_PATH = Path("/Users/donniedarko/Desktop/SEC_Training_Dataset/opus_labeled_training.jsonl")

CHUNK_SIZE = 1500      # ~512 tokens for DeBERTa
CHUNK_OVERLAP = 200    # overlap to avoid splitting entities at boundaries


# ============================================================
# REGEX PATTERNS for deterministic entity types
# ============================================================
REGEX_PATTERNS = {
    "EMAIL": re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'),
    "PHONE": re.compile(
        r'(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'
        r'|(?:\+\d{1,3}[-.\s]?)?\d{2,4}[-.\s]\d{3,4}[-.\s]\d{4}\b'
    ),
    "SSN": re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),
    "TAX_ID": re.compile(
        r'\b\d{2}-\d{7}\b'  # EIN format: XX-XXXXXXX
    ),
    "MONEY": re.compile(
        r'\$[\d,]+(?:\.\d{2})?\b'
        r'|\b\d[\d,]*(?:\.\d{2})?\s*(?:dollars?|USD)\b'
    ),
    "ZIPCODE": re.compile(r'\b\d{5}(?:-\d{4})?\b'),
}

# Date patterns — more conservative to avoid false positives
DATE_PATTERN = re.compile(
    r'\b(?:January|February|March|April|May|June|July|August|September|October|November|December)'
    r'\s+\d{1,2},?\s+\d{4}\b'
    r'|\b\d{1,2}/\d{1,2}/\d{2,4}\b'
    r'|\b\d{4}-\d{2}-\d{2}\b'
)


def find_all_occurrences(text: str, entity_text: str) -> list[tuple[int, int]]:
    """Find all non-overlapping occurrences of entity_text in text.
    Case-insensitive to catch ALL-CAPS variants in headers/signatures."""
    positions = []
    text_lower = text.lower()
    entity_lower = entity_text.lower()
    start = 0
    while True:
        idx = text_lower.find(entity_lower, start)
        if idx == -1:
            break
        positions.append((idx, idx + len(entity_text)))
        start = idx + len(entity_text)
    return positions


def detect_regex_entities(text: str) -> list[dict]:
    """Find all regex-detectable entities in a text chunk."""
    entities = []

    for label, pattern in REGEX_PATTERNS.items():
        for match in pattern.finditer(text):
            entities.append({
                "start": match.start(),
                "end": match.end(),
                "label": label,
                "value": match.group(),
            })

    # Dates
    for match in DATE_PATTERN.finditer(text):
        entities.append({
            "start": match.start(),
            "end": match.end(),
            "label": "DATE",
            "value": match.group(),
        })

    return entities


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[tuple[int, str]]:
    """Split text into overlapping chunks, preferring sentence/paragraph boundaries.
    Returns list of (global_offset, chunk_text) tuples."""
    chunks = []
    start = 0

    while start < len(text):
        end = start + chunk_size

        if end >= len(text):
            # Last chunk
            chunks.append((start, text[start:]))
            break

        # Try to break at paragraph boundary
        para_break = text.rfind('\n\n', start + chunk_size - 300, end)
        if para_break > start + chunk_size // 2:
            end = para_break + 2
        else:
            # Try sentence boundary
            sent_break = text.rfind('. ', start + chunk_size - 200, end)
            if sent_break > start + chunk_size // 2:
                end = sent_break + 2

        chunks.append((start, text[start:end]))
        start = end - overlap  # overlap for entity continuity

    return chunks


def process_document(doc_id: str, text: str, annotations: dict) -> list[dict]:
    """Process a single document into labeled training chunks."""
    chunks = chunk_text(text)
    samples = []

    for global_offset, chunk in chunks:
        entities = []

        # 1. Find Opus-annotated entities (ORG, PERSON, ADDRESS, etc.)
        for label, entity_list_key in [
            ("ORG", "orgs"),
            ("PERSON", "persons"),
            ("ADDRESS", "addresses"),
            ("LOCATION", "locations"),
        ]:
            for entity_text in annotations.get(entity_list_key, []):
                for local_start, local_end in find_all_occurrences(chunk, entity_text):
                    entities.append({
                        "start": local_start,
                        "end": local_end,
                        "label": label,
                        "value": entity_text,
                    })

        # 2. Add regex-detected entities
        regex_ents = detect_regex_entities(chunk)

        # Merge, avoiding overlaps (Opus annotations take priority)
        occupied = set()
        for ent in entities:
            for i in range(ent["start"], ent["end"]):
                occupied.add(i)

        for rent in regex_ents:
            if not any(i in occupied for i in range(rent["start"], rent["end"])):
                entities.append(rent)

        # Sort by start position
        entities.sort(key=lambda e: e["start"])

        # Skip chunks with no entities (pure boilerplate)
        if not entities:
            continue

        samples.append({
            "text": chunk,
            "entities": entities,
            "source": "opus_labeled",
            "original_doc": doc_id,
        })

    return samples


def main():
    if not ANNOTATIONS_PATH.exists():
        print(f"ERROR: {ANNOTATIONS_PATH} not found.")
        print("Create opus_annotations.jsonl first with entity annotations per doc.")
        sys.exit(1)

    # Load annotations
    annotations_by_doc = {}
    for line in ANNOTATIONS_PATH.read_text().strip().split("\n"):
        if line.strip():
            ann = json.loads(line)
            annotations_by_doc[ann["doc"]] = ann

    print(f"Loaded annotations for {len(annotations_by_doc)} documents")

    all_samples = []

    for txt_file in sorted(TXT_DIR.glob("*.txt")):
        doc_id = txt_file.stem

        if doc_id not in annotations_by_doc:
            print(f"  SKIP {doc_id} — no annotations")
            continue

        text = txt_file.read_text()
        ann = annotations_by_doc[doc_id]

        samples = process_document(doc_id, text, ann)
        all_samples.extend(samples)

        # Count entity types
        type_counts = {}
        for s in samples:
            for e in s["entities"]:
                type_counts[e["label"]] = type_counts.get(e["label"], 0) + 1

        print(f"  {doc_id}: {len(samples)} chunks, entities: {type_counts}")

    # Write output
    with open(OUTPUT_PATH, "w") as f:
        for sample in all_samples:
            f.write(json.dumps(sample) + "\n")

    print(f"\nTotal: {len(all_samples)} training samples written to {OUTPUT_PATH}")

    # Summary
    total_by_type = {}
    for s in all_samples:
        for e in s["entities"]:
            total_by_type[e["label"]] = total_by_type.get(e["label"], 0) + 1

    print("\nEntity distribution:")
    for label, count in sorted(total_by_type.items(), key=lambda x: -x[1]):
        print(f"  {label:15s}: {count:>6d}")


if __name__ == "__main__":
    main()
