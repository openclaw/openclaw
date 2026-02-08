# Internationalization Contribution Guide

This guide explains how to contribute translations to OpenClaw, helping make the application accessible to users worldwide.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Translation Workflow](#translation-workflow)
- [File Structure](#file-structure)
- [Translation Guidelines](#translation-guidelines)
- [Adding a New Language](#adding-a-new-language)
- [Testing Translations](#testing-translations)
- [Best Practices](#best-practices)
- [Tools and Resources](#tools-and-resources)

## Overview

OpenClaw uses a JSON-based internationalization (i18n) system with namespace organization. Translation files are located in `src/i18n/locales/` and organized by language code (e.g., `en.json`, `zh-CN.json`).

### Key Features

- **Namespace-based organization**: Strings are grouped by functionality (cli, errors, wizards, status, validation, common)
- **Parameter interpolation**: Dynamic values can be inserted into translations using `{{placeholder}}` syntax
- **Simple JSON format**: Easy to read and edit without specialized tools
- **Fallback to English**: Missing translations automatically fall back to English

## Getting Started

### Prerequisites

1. A GitHub account
2. Basic understanding of JSON format
3. Knowledge of the target language (native or near-native fluency recommended)
4. Understanding of the application's context

### Finding Translation Files

Translation files are located at:

```
src/i18n/locales/
  en.json        # English (source language)
  zh-CN.json     # Chinese (Simplified)
  # Add your language here
```

## Translation Workflow

### Step 1: Choose Your Language

If you're adding a new language, determine the correct locale code:

| Language              | Locale Code | Example File |
| --------------------- | ----------- | ------------ |
| English (US)          | `en`        | `en.json`    |
| Chinese (Simplified)  | `zh-CN`     | `zh-CN.json` |
| Chinese (Traditional) | `zh-TW`     | `zh-TW.json` |

For other languages, use standard IETF language tags (e.g., `ja` for Japanese, `ko` for Korean, `de` for German).

### Step 2: Copy the Source File

Copy `en.json` to your language file:

```bash
cp src/i18n/locales/en.json src/i18n/locales/[your-locale].json
```

### Step 3: Translate Strings

Edit your locale file and translate each string value. Keys must remain unchanged.

### Step 4: Test Your Translations

Run the i18n tests to verify your translations:

```bash
pnpm test src/i18n/i18n.test.ts
```

### Step 5: Submit a Pull Request

1. Commit your changes
2. Push to your fork
3. Create a pull request against the main repository

## File Structure

### Namespace Organization

Translations are organized into namespaces based on functionality:

| Namespace    | Purpose                  | Example Keys                   |
| ------------ | ------------------------ | ------------------------------ |
| `cli`        | CLI command descriptions | `help`, `version`, `status`    |
| `errors`     | Error messages           | `notFound`, `permissionDenied` |
| `wizards`    | Setup wizard prompts     | `welcomeTitle`, `scanQrCode`   |
| `status`     | Status messages          | `running`, `connected`         |
| `validation` | Form validation messages | `emailInvalid`, `minLength`    |
| `common`     | Common UI strings        | `yes`, `no`, `ok`, `cancel`    |

### Example Structure

```json
{
  "cli": {
    "help": "Help",
    "version": "Version"
  },
  "errors": {
    "notFound": "{{item}} not found",
    "permissionDenied": "Permission denied"
  },
  "wizards": {
    "welcomeTitle": "Welcome"
  }
}
```

## Translation Guidelines

### General Rules

1. **Preserve placeholders**: Keep `{{placeholder}}` syntax exactly as-is
2. **Maintain tone**: Match the original's formality (usually neutral/formal)
3. **Be consistent**: Use the same terminology throughout
4. **Consider context**: Translate for the application context, not literally

### Handling Placeholders

Placeholders (like `{{file}}`, `{{count}}`) must remain in the translation:

```json
// Original (English)
"fileNotFound": "File not found: {{file}}"

// Correct translation (Chinese)
"fileNotFound": "文件未找到: {{file}}"

// Incorrect - removed placeholder
"fileNotFound": "文件未找到"
```

### Pluralization

OpenClaw uses simple placeholder replacement. For plural forms, translate naturally:

```json
// Original
"issuesFound": "{{count}} issue(s) found"

// Translation (Chinese - no plural form distinction needed)
"issuesFound": "发现{{count}}个问题"
```

### Sentence Structure

Maintain the original sentence structure while making it natural in your language:

```json
// Original (passive voice)
"connectionFailed": "Connection failed"

// Translation (Chinese - natural equivalent)
"connectionFailed": "连接失败"
```

### Technical Terms

Translate technical terms consistently. Create a glossary if needed:

| English        | Chinese |
| -------------- | ------- |
| CLI            | CLI     |
| API key        | API密钥 |
| QR code        | 二维码  |
| authentication | 认证    |

## Adding a New Language

### Step 1: Create the Locale File

Copy `en.json` and rename it:

```bash
cp src/i18n/locales/en.json src/i18n/locales/[locale].json
```

### Step 2: Update Module Exports

Edit `src/i18n/config.ts` to add your locale:

```typescript
export const LOCALE_DE = "de" as const;
export const availableLocales = [LOCALE_EN, LOCALE_ZH_CN, LOCALE_ZH_TW, LOCALE_DE] as const;
```

### Step 3: Update Language Detector

Edit `src/i18n/detector.ts` to recognize your locale:

```typescript
const localeMappings: Record<string, SupportedLocale> = {
  // ... existing mappings
  de: "de",
  de_DE: "de",
  de_AT: "de",
};
```

### Step 4: Translate

Translate all strings in your locale file.

### Step 5: Test

Run tests and verify translations work correctly:

```bash
pnpm test src/i18n/i18n.test.ts
```

## Testing Translations

### Manual Testing

1. Set the locale environment variable:

   ```bash
   export OPENCLAW_LOCALE=zh-CN
   pnpm openclaw --help
   ```

2. Test with CLI flag:
   ```bash
   pnpm openclaw --lang zh-CN status
   ```

### Automated Testing

Run the i18n unit tests:

```bash
pnpm test src/i18n/i18n.test.ts
```

These tests verify:

- All translation keys exist
- Interpolation works correctly
- Locale switching functions properly
- Fallback behavior works

### Checking for Missing Keys

After adding translations, verify no keys are missing:

```typescript
// In i18n.test.ts, add:
it("should have all required keys for zh-CN", () => {
  const translator = createI18n(LOCALE_ZH_CN);
  const namespaces = translator.getNamespaces();
  // Verify each namespace has expected keys
});
```

## Best Practices

### 1. Translate in Context

When possible, use the application to understand how strings appear:

```bash
# Start the CLI and navigate through menus
pnpm openclaw
```

### 2. Keep Translations Natural

Avoid overly literal translations:

```json
// Too literal (unnatural)
"connectionFailed": "The attempt at connection has failed"

// Natural
"connectionFailed": "Connection failed"
```

### 3. Consistent Terminology

Create and follow a terminology list:

```json
// Always use "认证" for "authentication"
"authenticationFailed": "认证失败"
"waitingForAuth": "等待认证..."
```

### 4. Consider Text Length

Some languages use more characters than English. Ensure UI can handle longer text:

```json
// German often uses longer words
"validation": {
  "emailInvalid": "Bitte geben Sie eine gültige E-Mail-Adresse ein"
}
```

### 5. Test Edge Cases

Test with various inputs:

```typescript
// Long values
t("errors.fileNotFound", { file: "very-long-filename-that-might-cause-issues.json" });

// Special characters
t("errors.networkError", { reason: "ERROR_CONNECTION_REFUSED" });
```

### 6. Review Process

Before submitting:

- [ ] All strings translated
- [ ] Placeholders preserved
- [ ] JSON syntax valid
- [ ] Tests pass
- [ ] Consistent terminology
- [ ] Natural-sounding translations

## Tools and Resources

### JSON Validation

Validate your JSON file:

```bash
node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/[locale].json'))"
```

### Online JSON Validators

- [JSONLint](https://jsonlint.com/)
- [JSON Formatter](https://jsonformatter.org/)

### Language-Specific Resources

- **Chinese (Simplified)**: [现代汉语词典](https://www.zdic.net/)
- **Chinese (Traditional)**: [教育部重編國語辭典](https://dict.revised.moe.edu.tw/)
- **General**: [IETF Language Tags](https://www.iana.org/assignments/language-subtag-registry)

### Translation Memory

Consider using translation memory tools for consistency:

- [OmegaT](https://omegat.org/)
- [MemoQ](https://www.memoq.com/)
- [Transifex](https://www.transifex.com/)

## Support

### Getting Help

- **Issues**: Report translation issues on GitHub
- **Questions**: Ask in discussions or issues
- **Documentation**: See `docs/i18n/README.md`

### Reporting Problems

When reporting translation issues, include:

1. Locale and language
2. Translation key (e.g., `errors.fileNotFound`)
3. Current translation
4. Expected translation
5. Screenshot if UI-related

---

Thank you for helping make OpenClaw accessible to users worldwide! Your contributions are greatly appreciated.
