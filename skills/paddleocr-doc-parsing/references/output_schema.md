# PaddleOCR Document Parsing Output Schema

This document defines the output envelope returned by `vl_caller.py`.

By default, `vl_caller.py` saves the JSON envelope to a unique file under the system temp directory and prints the absolute saved path to `stderr`. Use `--output` when you need a custom destination, or `--stdout` when you want to skip file saving and print JSON directly.

## Output Envelope

`vl_caller.py` wraps provider response in a stable structure:

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
    "layoutParsingResults": [
      {
        "prunedResult": { ... },  // layout elements with position/content/confidence information
        "markdown": {
          "text": "Full page content in markdown/HTML format",
          "images": {
            "imgs/filename.jpg": "https://..."
          },
          "...": "other model-specific fields"
        }
      }
    ]
  }
}
```

## Important Fields

Paths are relative to the output envelope root.

- `result.result.layoutParsingResults[n].prunedResult`  
  Structured parsing data for page `n` (layout elements, locations, content, confidence, and related metadata).

- `result.result.layoutParsingResults[n].markdown`  
  Rendered output for page `n`.

- `result.result.layoutParsingResults[n].markdown.text`  
  Full page markdown text.

## Text Extraction

`vl_caller.py` extracts top-level `text` from `result.result.layoutParsingResults[n].markdown.text` and joins pages with `\n\n`.

## Command Examples

```bash
# Parse document from URL (result auto-saves to the system temp directory)
python scripts/vl_caller.py --file-url "URL" --pretty

# Parse local file (result auto-saves to the system temp directory)
python scripts/vl_caller.py --file-path "doc.pdf" --pretty

# Parse with explicit file type
python scripts/vl_caller.py --file-url "URL" --file-type 1 --pretty

# Save result to a custom file path
python scripts/vl_caller.py --file-url "URL" --output "./result.json" --pretty

# Print JSON to stdout without saving a file
python scripts/vl_caller.py --file-url "URL" --stdout --pretty
```
