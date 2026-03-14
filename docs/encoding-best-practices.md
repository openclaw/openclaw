# Encoding Best Practices

This document outlines best practices for handling file encoding, particularly for non-ASCII characters such as Chinese, Japanese, and Korean (CJK) characters.

## Overview

Proper handling of file encoding is crucial for internationalization and ensuring data integrity across different systems and platforms.

## UTF-8 Encoding

Always use UTF-8 encoding for text files to ensure compatibility with international characters.

### File Operations

When reading or writing files with non-ASCII characters:

1. **Explicitly specify encoding**: Always set `encoding='utf-8'` when opening files
2. **Handle BOM (Byte Order Mark)**: Be aware of UTF-8 BOM when reading files from Windows systems
3. **Validate encoding**: Check file encoding before processing

### Example

```python
# Good practice - explicit UTF-8 encoding
with open('filename.txt', 'r', encoding='utf-8') as f:
    content = f.read()

# Writing with UTF-8
with open('output.txt', 'w', encoding='utf-8') as f:
    f.write('中文内容')  # Chinese content
```

## Filename Handling

### Cross-Platform Compatibility

- **Windows**: Supports Unicode filenames but may have legacy encoding issues
- **Linux/macOS**: Native UTF-8 support
- **WSL**: Ensure proper mount options for Windows drives

### Best Practices

1. Use ASCII characters in filenames when possible for maximum compatibility
2. When using non-ASCII filenames, ensure all systems in the pipeline support UTF-8
3. Test file operations on all target platforms

## Testing

Always test file operations with:
- Chinese characters (中文)
- Japanese characters (日本語)
- Korean characters (한국어)
- Emoji (🔧)
- Special symbols (√, ∞, ©)

## Related Issues

- Fixes encoding issues reported in #41512
