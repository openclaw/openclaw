---
name: regex-helper
description: Build, explain, test, and debug regular expressions. Use when the user needs help writing regex patterns, wants a regex explained in plain English, needs to test a pattern against sample text, or is debugging why a regex doesn't match. Supports PCRE, JavaScript, Python, and POSIX flavors.
metadata:
  { "openclaw": { "emoji": "🔍" } }
---

# Regex Helper

Help users write, understand, and debug regular expressions.

## Capabilities

### 1. Explain a regex

Break down a pattern into plain English, character by character:

```
Pattern: ^(?:https?:\/\/)?(?:www\.)?([^\/]+)
Explanation:
  ^            - Start of string
  (?:https?://)? - Optional http:// or https:// (non-capturing)
  (?:www\.)?   - Optional "www." prefix (non-capturing)
  ([^\/]+)     - Capture one or more non-slash characters (the domain)
```

### 2. Generate from description

```
"Match email addresses"  →  [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
"Extract hashtags"       →  #(\w+)
"Match IPv4 addresses"   →  \b(?:\d{1,3}\.){3}\d{1,3}\b
```

### 3. Test against input

Use Python to test patterns:

```bash
python3 -c "
import re
pattern = r'YOUR_PATTERN'
text = '''YOUR_TEXT'''
matches = re.findall(pattern, text)
print(f'Matches ({len(matches)}):')
for m in matches: print(f'  {m!r}')
"
```

### 4. Debug non-matches

When a pattern doesn't match, explain why and suggest fixes.

## Flavor Differences

| Feature | JavaScript | Python | PCRE | POSIX |
|---------|-----------|--------|------|-------|
| Lookahead | ✅ | ✅ | ✅ | ❌ |
| Lookbehind | ✅ (fixed) | ✅ (variable) | ✅ | ❌ |
| Named groups | `(?<name>)` | `(?P<name>)` | Both | ❌ |
| `\d` | `[0-9]` | Unicode | `[0-9]` | N/A |

## Guidelines

- Always ask which language/tool if ambiguous
- Warn about common pitfalls (greedy vs lazy, anchoring, Unicode)
- Provide test cases with the generated pattern
- For complex patterns, build incrementally and explain each step
