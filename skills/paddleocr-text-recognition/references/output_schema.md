# PaddleOCR Text Recognition Output Schema

This document defines the output envelope returned by `ocr_caller.py`.

By default, `ocr_caller.py` saves the JSON envelope to a unique file under the system temp directory and prints the absolute saved path to `stderr`. Use `--output` when you need a custom destination, or `--stdout` when you want to skip file saving and print JSON directly.

## Output Envelope

`ocr_caller.py` wraps provider response in a stable structure:

```json
{
  "ok": true,
  "text": "Extracted text from all pages",
  "result": { ... },  // raw provider response
  "error": null
}
```

On error:

```json
{
  "ok": false,
  "text": "",
  "result": null,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

## Error Codes

| Code           | Description                                                                |
| -------------- | -------------------------------------------------------------------------- |
| `INPUT_ERROR`  | Invalid or unusable input (arguments, file source, format, types).         |
| `CONFIG_ERROR` | Missing or invalid API / client configuration.                             |
| `API_ERROR`    | Request or response handling failed (network, HTTP, body parsing, schema). |

## Raw Result Notes

The `result` field contains raw provider output.  
Raw fields may vary by model version and endpoint.

## Raw Result Example

```json
{
  "logId": "request-uuid",
  "errorCode": 0,
  "errorMsg": "Success",
  "result": {
    "ocrResults": [
      {
        "prunedResult": {
          "rec_texts": ["First line", "Second line"],
          "rec_scores": [0.98, 0.95],
          "...": "other OCR fields"
        },
        "ocrImage": "https://...",
        "inputImage": "https://...",
        "...": "other model-specific fields"
      }
    ],
    "dataInfo": {
      "numPages": 1,
      "type": "pdf",
      "...": "other metadata"
    },
    "...": "other top-level fields"
  }
}
```

## Stable Fields for Downstream Use

Paths are relative to the output envelope root.

- `result.result.ocrResults[n].prunedResult`  
  Structured OCR data for page `n`.

- `result.result.ocrResults[n].prunedResult.rec_texts`  
  Recognized text lines for page `n`.

- `result.result.ocrResults[n].prunedResult.rec_scores`  
  Confidence scores for recognized text lines.

## Text Extraction

`ocr_caller.py` extracts top-level `text` from `result.result.ocrResults[n].prunedResult.rec_texts`, joins lines with `\n`, and joins pages with `\n\n`.

## Command Examples

```bash
# OCR from URL (result auto-saves to the system temp directory)
python scripts/ocr_caller.py --file-url "URL" --pretty

# OCR local file (result auto-saves to the system temp directory)
python scripts/ocr_caller.py --file-path "doc.pdf" --pretty

# OCR with explicit file type
python scripts/ocr_caller.py --file-url "URL" --file-type 1 --pretty

# Save result to a custom file path
python scripts/ocr_caller.py --file-url "URL" --output "./result.json" --pretty

# Print JSON to stdout without saving a file
python scripts/ocr_caller.py --file-url "URL" --stdout --pretty
```
