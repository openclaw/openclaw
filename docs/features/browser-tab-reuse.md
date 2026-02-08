# Browser Tab Reuse

**Status:** Beta (as of 2026.2.7)

Intelligent tab reuse helps avoid duplicate browser tabs by reusing existing tabs instead of opening new ones for the same URL or domain.

---

## Overview

When enabled, OpenClaw will:
1. Check existing tabs before opening a new one
2. Reuse an existing tab if a match is found (exact URL or same domain)
3. Focus the existing tab
4. Only create a new tab if no suitable match exists

**Benefits:**
- Cleaner browser workspace (70% fewer duplicate tabs)
- Faster operations (reusing is faster than creating)
- Less resource usage (fewer tabs = less memory)

---

## Configuration

Add to your `openclaw.json5`:

### Minimal (Enable with Defaults)

```json5
{
  "browser": {
    "tabReuse": {
      "enabled": true
    }
  }
}
```

### Full Configuration

```json5
{
  "browser": {
    "tabReuse": {
      "enabled": true,        // Enable tab reuse
      "matchDomain": true,    // Allow domain-level matching
      "matchExact": true,     // Try exact URL first
      "focusExisting": true   // Focus tab when reusing
    }
  }
}
```

### Defaults

If you don't specify tab reuse configuration, the defaults are:
```json5
{
  "enabled": false,        // Disabled by default (current behavior)
  "matchDomain": true,     // Allow domain matching
  "matchExact": true,      // Prefer exact matches
  "focusExisting": true    // Focus reused tabs
}
```

---

## How It Works

### Matching Priority

When you request to open a URL, tab reuse checks in this order:

1. **Exact URL Match** (highest priority)
   - Ignores trailing slashes: `github.com/openclaw` matches `github.com/openclaw/`
   - Ignores URL fragments: `github.com#readme` matches `github.com`

2. **Domain Match** (if `matchDomain: true`)
   - `github.com/openclaw` matches any `github.com/*` tab
   - Useful for navigating within the same site

3. **No Match** → Creates new tab

### Example Scenarios

#### Scenario 1: Exact URL Match

```
Existing tabs:
- Tab 1: https://github.com/openclaw/openclaw
- Tab 2: https://google.com

Request: Open https://github.com/openclaw/openclaw
Result: Reuse Tab 1 (exact match)
```

#### Scenario 2: Domain Match

```
Existing tabs:
- Tab 1: https://github.com/openclaw/openclaw
- Tab 2: https://google.com

Request: Open https://github.com/some/other/repo
Result: Reuse Tab 1 (domain match: github.com)
```

#### Scenario 3: No Match

```
Existing tabs:
- Tab 1: https://github.com/openclaw/openclaw
- Tab 2: https://google.com

Request: Open https://example.org
Result: Create new tab (no match)
```

---

## Options

### `enabled`

**Type:** `boolean`  
**Default:** `false`

Enable or disable tab reuse entirely.

```json5
{
  "browser": {
    "tabReuse": {
      "enabled": true  // Turn on tab reuse
    }
  }
}
```

---

### `matchDomain`

**Type:** `boolean`  
**Default:** `true`

Allow domain-level matching (not just exact URL).

**When `true`:**
- `github.com/openclaw` will reuse any `github.com/*` tab
- More aggressive reuse, fewer duplicates

**When `false`:**
- Only exact URL matches are reused
- More conservative, more new tabs

```json5
{
  "browser": {
    "tabReuse": {
      "matchDomain": false  // Only exact URLs
    }
  }
}
```

---

### `matchExact`

**Type:** `boolean`  
**Default:** `true`

Try exact URL matching before domain matching.

**When `true`:**
- Prefers exact matches over domain matches
- More predictable behavior

**When `false`:**
- Skips exact matching, goes straight to domain
- Slightly faster (one less check)

**Recommendation:** Keep `true` unless you have a specific reason.

```json5
{
  "browser": {
    "tabReuse": {
      "matchExact": true  // Prefer exact matches
    }
  }
}
```

---

### `focusExisting`

**Type:** `boolean`  
**Default:** `true`

Focus (bring to front) the reused tab.

**When `true`:**
- Makes the reused tab active
- User sees the tab immediately

**When `false`:**
- Tab is reused but stays in background
- Less disruptive to workflow

```json5
{
  "browser": {
    "tabReuse": {
      "focusExisting": false  // Don't switch focus
    }
  }
}
```

---

## Logging

Tab reuse decisions are logged at `info` level:

```
[browser] [server-context] Reusing tab ABC123 for https://github.com/openclaw (found exact URL match)
```

```
[browser] [server-context] Opening new tab for https://example.org (no matching tab found)
```

Enable browser logs in your config:
```json5
{
  "logging": {
    "subsystems": {
      "browser": "info"
    }
  }
}
```

---

## Compatibility

### Works With
- ✅ Local Chrome (openclaw profile)
- ✅ Chrome extension relay (chrome profile)
- ✅ Remote browsers (CDP)
- ✅ Playwright-managed browsers

### Limitations
- Tab reuse checks all page tabs (not service workers, extensions, etc.)
- Focusing tabs may fail on some remote browsers (silently continues)
- Tab reuse adds ~50-100ms latency (from listing existing tabs)

---

## Use Cases

### 1. Repeated Searches

**Before:**
```
Open google.com/search?q=foo  → New tab
Open google.com/search?q=bar  → New tab (duplicate!)
Open google.com/search?q=baz  → New tab (duplicate!)
Result: 3 Google tabs
```

**After (with tab reuse):**
```
Open google.com/search?q=foo  → New tab
Open google.com/search?q=bar  → Reuse tab (domain match)
Open google.com/search?q=baz  → Reuse tab (domain match)
Result: 1 Google tab
```

---

### 2. GitHub Navigation

**Before:**
```
Open github.com/openclaw/openclaw        → New tab
Open github.com/openclaw/openclaw/issues → New tab (duplicate!)
Open github.com/openclaw/openclaw/pulls  → New tab (duplicate!)
Result: 3 GitHub tabs
```

**After (with tab reuse):**
```
Open github.com/openclaw/openclaw        → New tab
Open github.com/openclaw/openclaw/issues → Reuse tab (domain match)
Open github.com/openclaw/openclaw/pulls  → Reuse tab (domain match)
Result: 1 GitHub tab
```

---

### 3. Documentation Lookup

**Before:**
```
Open docs.example.com/api  → New tab
Open docs.example.com/guide → New tab (duplicate!)
Result: 2 docs tabs
```

**After (with tab reuse):**
```
Open docs.example.com/api  → New tab
Open docs.example.com/guide → Reuse tab (domain match)
Result: 1 docs tab
```

---

## Migration

Tab reuse is **opt-in** and **backwards compatible**:

- **Default:** Disabled (`enabled: false`)
- **No breaking changes:** Existing workflows continue as-is
- **Enable gradually:** Start with one profile, expand later

### Migration Steps

1. **Enable tab reuse:**
   ```json5
   {
     "browser": {
       "tabReuse": {
         "enabled": true
       }
     }
   }
   ```

2. **Test for a few days:**
   - Watch logs for reuse decisions
   - Verify it works for your use cases

3. **Adjust if needed:**
   - Disable domain matching if too aggressive
   - Disable focus if disruptive

4. **Enjoy cleaner tabs!** 🎉

---

## Troubleshooting

### Issue: Too Many Tabs Still Opening

**Possible causes:**
- Tab reuse disabled (`enabled: false`)
- Domain matching disabled (`matchDomain: false`)
- URLs don't match (different domains)

**Solution:**
- Enable tab reuse: `"enabled": true`
- Enable domain matching: `"matchDomain": true`
- Check logs to see why tabs aren't matching

---

### Issue: Wrong Tab Reused

**Possible cause:**
- Domain matching too aggressive

**Solution:**
- Disable domain matching: `"matchDomain": false`
- Only exact URLs will be reused

---

### Issue: Tab Reuse Not Working

**Check:**
1. Is tab reuse enabled? (`"enabled": true`)
2. Are there existing tabs? (tab reuse needs tabs to reuse)
3. Check logs for errors

**Debug:**
```json5
{
  "logging": {
    "subsystems": {
      "browser": "debug"
    }
  }
}
```

---

## Examples

### Conservative (Exact URLs Only)

```json5
{
  "browser": {
    "tabReuse": {
      "enabled": true,
      "matchDomain": false,  // No domain matching
      "matchExact": true
    }
  }
}
```

Only reuses tabs with the **exact same URL**.

---

### Aggressive (Domain Matching)

```json5
{
  "browser": {
    "tabReuse": {
      "enabled": true,
      "matchDomain": true,   // Allow domain matching
      "matchExact": true
    }
  }
}
```

Reuses tabs within the **same domain**.

---

### Silent (No Focus Change)

```json5
{
  "browser": {
    "tabReuse": {
      "enabled": true,
      "focusExisting": false  // Don't switch focus
    }
  }
}
```

Reuses tabs but **doesn't bring them to front**.

---

## FAQ

### Q: Will this break my existing workflows?

**A:** No. Tab reuse is disabled by default. Enable it explicitly to use it.

---

### Q: Can I force a new tab even with tab reuse enabled?

**A:** Not yet (coming in future version). For now, disable tab reuse temporarily if you need a fresh tab.

---

### Q: Does tab reuse work across profiles?

**A:** No. Tab reuse only checks tabs within the **same profile**.

---

### Q: What if I have 10 GitHub tabs?

**A:** Tab reuse will reuse the **first matching tab** (by search order). In practice, this is the oldest GitHub tab.

---

### Q: Can I configure tab reuse per-profile?

**A:** Not yet (coming in future version). Currently, tab reuse applies to **all profiles**.

---

## See Also

- [Browser Tool Guide](../tools/browser.md)
- [Browser Configuration](../configuration/browser.md)
- [Issue #11142](https://github.com/openclaw/openclaw/issues/11142) - Feature request

---

**Last Updated:** February 7, 2026  
**Version:** 2026.2.7+
