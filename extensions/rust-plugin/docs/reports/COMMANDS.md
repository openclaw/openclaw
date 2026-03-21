# 🚀 Rust Plugin - Command Reference

**Date**: 2026-03-20
**Status**: Production Ready

---

## 📋 **Quick Start Commands**

### **Build & Test**

```bash
# Build the plugin
pnpm build

# Build only rust-plugin
cd extensions/rust-plugin && pnpm build

# Test native addon
cd extensions/rust-plugin
node -e "const m = require('./native'); console.log('✓ Loaded', Object.keys(m).length, 'functions');"

# Test plugin loading
node -e "import('./dist/extensions/rust-plugin/index.js').then(m => console.log('✓ Plugin loaded'))"
```

### **OpenClaw Integration**

```bash
# Start gateway
pnpm openclaw gateway run

# Check plugin status
pnpm openclaw plugins status

# List tools
pnpm openclaw tools list | grep rust
```

### **Testing**

```bash
# Test native functions
cd extensions/rust-plugin
node -e "
const native = require('./native');
console.log('UUID:', native.generateUuid());
console.log('Hash:', native.computeHash('hello', 'sha256'));
"

# Run integration tests
node test-manual.js
```

---

## 🔧 **Development Commands**

### **Rust Development**

```bash
# Build native addon
cd extensions/rust-plugin/native
cargo build --release

# Build with debug symbols
cargo build

# Run Rust tests
cargo test

# Check Rust code
cargo clippy

# Format Rust code
cargo fmt
```

### **TypeScript Development**

```bash
# Type check
pnpm tsgo

# Lint
pnpm lint

# Format
pnpm format:fix

# Check all
pnpm check
```

### **Testing**

```bash
# Run all tests
pnpm test

# Run coverage
pnpm test:coverage

# Run specific test
pnpm test -- rust-plugin
```

---

## 📊 **Debugging Commands**

### **Native Module Debugging**

```bash
# Check if native module loads
cd extensions/rust-plugin
node -e "const m = require('./native'); console.log(Object.keys(m));"

# Test specific function
node -e "const m = require('./native'); console.log(m.processString('HELLO', { toLowerCase: true }));"

# Check module paths
node -e "
const path = require('path');
const fs = require('fs');
const dirs = ['./native', './native/target/release'];
dirs.forEach(d => {
  const fullPath = path.resolve(d);
  console.log(d, ':', fs.existsSync(fullPath));
});
"
```

### **Plugin Debugging**

```bash
# Check plugin metadata
cat dist/extensions/rust-plugin/openclaw.plugin.json

# Check plugin build output
ls -lh dist/extensions/rust-plugin/

# Test plugin import
node -e "
import('./dist/extensions/rust-plugin/index.js').then(({ default: plugin }) => {
  console.log('Plugin ID:', plugin.id);
  console.log('Plugin Name:', plugin.name);
  console.log('Has Register:', typeof plugin.register);
});
"
```

---

## 🚀 **Deployment Commands**

### **Pre-Publication Checklist**

```bash
# 1. Build everything
pnpm build

# 2. Run tests
pnpm test

# 3. Run lint
pnpm check

# 4. Test native addon
cd extensions/rust-plugin
node -e "const m = require('./native'); console.log('✓', Object.keys(m).length, 'functions');"

# 5. Test plugin
node -e "import('./dist/extensions/rust-plugin/index.js').then(() => console.log('✓ Plugin OK'))"
```

### **Publishing**

```bash
# From rust-plugin directory
cd extensions/rust-plugin

# 1. Update version (if needed)
# Edit package.json

# 2. Build
pnpm build

# 3. Test
pnpm test

# 4. Publish
npm publish
```

---

## 📝 **Useful One-Liners**

### **Quick Checks**

```bash
# Check native addon
node -e "console.log(Object.keys(require('./extensions/rust-plugin/native')).length)"

# Check plugin build
ls -lh dist/extensions/rust-plugin/index.js

# Check TypeScript errors
pnpm tsgo 2>&1 | grep rust-plugin | head -20

# Check security
cat extensions/rust-plugin/SECURITY_AUDIT_REPORT.md | grep -A5 "Status"
```

### **Performance Testing**

```bash
# Benchmark
cd extensions/rust-plugin
node -e "
const native = require('./native');
(async () => {
  const result = await native.benchmark(1000000);
  console.log('Benchmark:', result);
})();
"

# Hash performance
node -e "
const crypto = require('crypto');
const start = Date.now();
for (let i = 0; i < 10000; i++) {
  crypto.createHash('sha256').update('hello').digest('hex');
}
console.log('JS:', Date.now() - start, 'ms');
"
```

---

## 🔍 **Troubleshooting**

### **Native Module Not Loading**

```bash
# Check file exists
ls -lh extensions/rust-plugin/native/rust_plugin.node

# Check loader
cat extensions/rust-plugin/native/index.cjs

# Test direct load
cd extensions/rust-plugin/native
node -e "const m = require('./rust_plugin.node'); console.log(Object.keys(m).length);"
```

### **Plugin Not Found**

```bash
# Check dist
ls -lh dist/extensions/rust-plugin/

# Check metadata
cat dist/extensions/rust-plugin/openclaw.plugin.json

# Rebuild
pnpm build
```

### **TypeScript Errors**

```bash
# Check tsconfig
cat tsconfig.json | grep -A5 "rust-plugin"

# Type check
pnpm tsgo 2>&1 | grep -A3 "error TS"

# Lint
pnpm lint 2>&1 | grep rust-plugin
```

---

## 📞 **Getting Help**

### **Documentation**

- README.md - User guide
- DEBUG_NATIVE_LOADING.md - Debugging guide
- TEST_RESULTS.md - Test results
- SECURITY_AUDIT_REPORT.md - Security info

### **Logs**

- Build logs: `pnpm build 2>&1 | tee build.log`
- Test logs: `pnpm test 2>&1 | tee test.log`
- Gateway logs: `~/.openclaw/logs/`

### **Debug Mode**

```bash
# Enable debug output
DEBUG=* pnpm openclaw gateway run

# Verbose build
OPENCLAW_BUILD_VERBOSE=1 pnpm build

# Test with debug
node --inspect test-manual.js
```

---

## ✅ **Success Indicators**

### **Build Success**

```bash
✓ dist/extensions/rust-plugin/index.js exists
✓ dist/extensions/rust-plugin/openclaw.plugin.json valid
✓ No TypeScript errors
✓ No lint errors
```

### **Runtime Success**

```bash
✓ Native addon loads: 65 functions
✓ Plugin loads: { id, name, register }
✓ Functions work: UUID, hash, etc.
✓ No crashes or errors
```

### **Integration Success**

```bash
✓ Gateway starts without errors
✓ Plugin shows in status
✓ Tools registered: 36 tools
✓ Agent can use tools
```

---

**Last Updated**: 2026-03-20
**Status**: Production Ready
**Version**: 2026.3.19

---

_This command reference provides all essential commands for developing, testing, and deploying the rust-plugin._
