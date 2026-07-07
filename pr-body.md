## Summary

Adds internationalization (i18n) support for the dreaming journal system, allowing users to customize the language of section headers and status messages.

## Changes

### Core Changes
- **New file**: `extensions/memory-core/src/dreaming-i18n.ts` - i18n module with translations for:
  - English (en)
  - Chinese Simplified (zh-CN)
  - Chinese Traditional (zh-TW)
  - Japanese (ja)
  - Korean (ko)

- **Config support**: Added `language` field to `MemoryDreamingConfig` type in `src/memory-host-sdk/dreaming.ts`
  - Users can now set `language: "zh-CN"` in their dreaming config

- **Patch script**: `scripts/patch-dreaming-i18n.sh` - Quick patch script for immediate use
  - Applies translations to compiled JavaScript files
  - Usage: `./scripts/patch-dreaming-i18n.sh [language]`

### What This Enables

Before this PR:
- Dreaming journal headers were hardcoded in English
- Non-English users had inconsistent language experience
- Manual patching required editing compiled JS files

After this PR:
- Foundation for full i18n support
- Language config in dreaming settings
- Patch script for immediate use
- Easy to add new languages

## Example Config

```json
{
  "plugins": {
    "config": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "language": "zh-CN"
          }
        }
      }
    }
  }
}
```

## TODO (Future Work)

- [ ] Propagate language config through the entire call chain
- [ ] Update all dreaming phase files to use translations
- [ ] Add language selection UI in Control UI
- [ ] Community translations for more languages

## Related

- Closes #101314

---

Co-authored-by: 杞人 (Qǐrén) <qiren@openclaw>
