# PSD Automator Error Codes

- `E_TASK_INVALID`: task JSON malformed or missing required fields.
- `E_FILE_NOT_FOUND`: target PSD was not found.
- `E_FILE_LOCKED`: PSD is locked/in use by another process.
- `E_LAYER_NOT_FOUND`: requested text layer name does not exist.
- `E_STYLE_MISMATCH`: font/size changed unexpectedly after replacement.
- `E_PHOTOSHOP_UNAVAILABLE`: Photoshop process/automation API not available.
- `E_EXEC_TIMEOUT`: Photoshop script execution timeout.
- `E_EXEC_FAILED`: Photoshop script returned a generic failure.
- `E_BACKUP_FAILED`: backup copy failed before write.
- `E_OUTPUT_WRITE_FAILED`: output save/copy failed.
- `E_EXPORT_FAILED`: export step (for example PNG) failed.
- `E_PARSE_FAILED`: natural-language parsing failed for required fields.
- `E_FILE_AMBIGUOUS`: multiple candidate PSD files match and confirmation is required.
- `E_INDEX_MISSING`: index file not found when needed for `fileHint`.
- `E_INDEX_CORRUPT`: index JSON invalid.
- `E_PLATFORM_UNSUPPORTED`: current platform is not macOS or Windows.
