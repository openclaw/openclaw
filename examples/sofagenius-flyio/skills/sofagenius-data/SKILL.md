---
name: sofagenius-data
description: Inspect and analyze ML datasets via SofaGenius. Search HuggingFace, run SQL on parquet files, detect formats, and convert datasets.
metadata: {"openclaw": {"emoji": "🗄️", "requires": {"anyBins": ["python3", "python"], "env": ["HF_TOKEN"]}}}
---

# SofaGenius Data Inspector

This skill bridges to the SofaGenius backend for dataset operations.
SofaGenius handles all data logic (DuckDB SQL, HF parquet queries, format detection).

## When to use

- User wants to search HuggingFace for datasets
- User wants to run SQL queries on a parquet-backed dataset
- User wants to inspect dataset format or statistics
- User wants to convert a dataset to a different format

## Search for datasets

```bash
python3 {baseDir}/scripts/bridge.py data-search --query "<search terms>"
```

## Run SQL on a dataset

```bash
python3 {baseDir}/scripts/bridge.py data-sql --dataset "<hf_dataset_id>" --query "<sql query>"
```

## Detect dataset format

```bash
python3 {baseDir}/scripts/bridge.py data-format --dataset "<hf_dataset_id>"
```

Detects: chatml, instruction, QA, completion, preference formats.

## Get dataset statistics

```bash
python3 {baseDir}/scripts/bridge.py data-stats --dataset "<hf_dataset_id>"
```
