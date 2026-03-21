# Debug Session: Native Module Loading Issue

**Date**: 2026-03-20
**Issue**: Native module loading returned empty object instead of 65 functions

## Problem

When requiring the native module via `require('./native')`, it returned an empty object `{}` instead of the expected 65 functions from `rust_plugin.node`.

## Root Cause

Multiple issues:

1. **`__dirname` resolution**: When loaded from the parent directory, `__dirname` was resolving to the parent directory instead of the `native/` directory
2. **ES Module vs CommonJS**: The `package.json` had `"type": "module"`, which meant `.js` files were treated as ES modules, not CommonJS
3. **Module caching**: The module was being cached with 0 functions before the native addon was loaded

## Debugging Steps

### 1. Verified .node file exists

```bash
cd extensions/rust-plugin
find . -name "*.node" -type f
# Output: ./native/rust_plugin.node
```

### 2. Tested direct loading

```bash
cd extensions/rust-plugin/native
node -e "const addon = require('./rust_plugin.node'); console.log(Object.keys(addon).length);"
# Output: 65 ✓
```

### 3. Tested loading from parent

```bash
cd extensions/rust-plugin
node -e "const addon = require('./native'); console.log(Object.keys(addon).length);"
# Output: 0 ✗
```

### 4. Discovered ES Module issue

```bash
cd extensions/rust-plugin
cat > test-require.js << 'EOF'
const path = require('path');
EOF
node test-require.js
# Error: require is not defined in ES module scope
```

**Root Cause**: `package.json` has `"type": "module"`, so `.js` files are ES modules!

### 5. Solution: Use `.cjs` extension

Renamed `native/index.js` to `native/index.cjs` to force CommonJS mode.

### 6. Updated require.resolve path

Changed from:

```javascript
const modulePath = require.resolve("./native/index.js");
```

To:

```javascript
const modulePath = require.resolve("./index.cjs");
```

### 7. Created package.json for native directory

Created `native/package.json`:

```json
{
  "name": "@openclaw/rust-plugin-native",
  "main": "index.cjs"
}
```

This allows `require('./native')` to work correctly.

## Final Solution

### File: `native/index.cjs`

```javascript
"use strict";

const path = require("path");
const fs = require("fs");

// Find the .node file
const searchDirs = [
  __dirname || path.dirname(require.resolve("./index.cjs")),
  path.dirname(require.resolve("./index.cjs")),
];

let loaded = false;
for (const dir of searchDirs) {
  const nodePath = path.join(dir, "rust_plugin.node");
  if (fs.existsSync(nodePath)) {
    try {
      const nativeModule = require(nodePath);
      if (nativeModule && Object.keys(nativeModule).length > 0) {
        module.exports = nativeModule;
        loaded = true;
        break;
      }
    } catch (err) {
      // Continue
    }
  }
}

if (!loaded) {
  module.exports = {};
}
```

### File: `native/package.json`

```json
{
  "name": "@openclaw/rust-plugin-native",
  "main": "index.cjs"
}
```

## Key Learnings

1. **ES Module vs CommonJS**: When `package.json` has `"type": "module"`, all `.js` files are treated as ES modules. Use `.cjs` extension for CommonJS files.

2. **`__dirname` and `__filename`**: In CommonJS modules loaded via a directory (e.g., `require('./native')`), these are relative to the calling script, not the module location.

3. **`require.resolve()`**: Always returns the absolute path of the module file, regardless of how it was loaded.

4. **Module loaders**: Use `require.resolve()` to get reliable paths, not `__dirname` or `__filename`.

5. **Directory requires**: To make `require('./native')` work, create a `package.json` in the directory with `"main"` pointing to the entry file.

6. **Debug output**: `console.error()` statements are essential for seeing what's happening during module loading.

7. **Test from both locations**: Always test native module loading from:
   - The same directory (direct `require('./file.node')`)
   - The parent directory (directory require `require('./native')`)

## Related Files

- `extensions/rust-plugin/native/index.cjs` (module loader)
- `extensions/rust-plugin/native/package.json` (module configuration)
- `extensions/rust-plugin/native/rust_plugin.node` (compiled native addon)
- `extensions/rust-plugin/native/index.d.ts` (TypeScript definitions)

## Testing Command

```bash
cd extensions/rust-plugin
node -e "const m = require('./native'); console.log('✓ Loaded', Object.keys(m).length, 'functions');"
```

Expected output: `✓ Loaded 65 functions`

## Verification

```bash
cd extensions/rust-plugin
node -e "const m = require('./native'); console.log('✓ Loaded', Object.keys(m).length, 'functions'); console.log('Has processString?', typeof m.processString); console.log('Has generateUuid?', typeof m.generateUuid);"
```

Expected output:

```
✓ Loaded 65 functions
Has processString? function
Has generateUuid? function
```
