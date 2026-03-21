# 🔧 **Building Custom Rust Plugins for OpenClaw**

**A complete guide for developers who want to create their own Rust-powered OpenClaw plugins**

---

## 📋 **Prerequisites**

### **Required Tools**

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js 18+
node --version  # Should be 18 or higher

# OpenClaw repository
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
```

### **Rust Targets**

```bash
# Add Rust targets for different platforms
rustup target add x86_64-unknown-linux-gnu
rustup target add x86_64-unknown-linux-musl
rustup target add aarch64-unknown-linux-gnu
rustup target add aarch64-unknown-linux-musl
rustup target add x86_64-apple-darwin
rustup target add aarch64-apple-darwin
rustup target add x86_64-pc-windows-msvc
```

---

## 🏗️ **Project Structure**

### **Minimal Rust Plugin Structure**

```
extensions/my-rust-plugin/
├── package.json              # npm metadata + OpenClaw config
├── index.ts                  # Plugin entry point
├── native/
│   ├── Cargo.toml           # Rust dependencies
│   ├── build.rs             # Build script
│   ├── index.cjs            # Native module loader
│   ├── index.d.ts           # TypeScript definitions
│   └── src/
│       ├── lib.rs           # Main Rust exports
│       └── functions.rs     # Your Rust functions
└── README.md
```

---

## 📦 **Step-by-Step Guide**

### **Step 1: Create Package.json**

```json
{
  "name": "@openclaw/my-rust-plugin",
  "version": "2026.3.20",
  "description": "My custom Rust plugin for OpenClaw",
  "type": "module",
  "main": "index.js",
  "types": "index.d.ts",
  "scripts": {
    "build": "napi build --platform --release ./native",
    "build:debug": "napi build --platform ./native",
    "test": "vitest run index.test.ts"
  },
  "dependencies": {},
  "devDependencies": {
    "@napi-rs/cli": "^3.0.0",
    "vitest": "^2.0.0"
  },
  "napi": {
    "name": "my_rust_plugin",
    "triples": {
      "defaults": true
    }
  },
  "openclaw": {
    "extensions": ["./index.ts"],
    "install": {
      "npmSpec": "@openclaw/my-rust-plugin",
      "localPath": "extensions/my-rust-plugin"
    },
    "release": {
      "publishToNpm": true
    }
  }
}
```

### **Step 2: Create Rust Code**

**`native/Cargo.toml`**:

```toml
[package]
name = "my-rust-plugin"
version = "2026.3.20"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "3.0.0", features = ["async"] }
napi-derive = "3.0.0"
tokio = { version = "1", features = ["full"] }

[build-dependencies]
napi-build = "2.0.0"
```

**`native/src/lib.rs`**:

```rust
use napi_derive::napi;

/// Simple greeting function
#[napi]
pub fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}

/// Add two numbers
#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// Async computation
#[napi]
pub async fn compute_expensive() -> u32 {
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    42
}
```

### **Step 3: Create Native Module Loader**

**`native/index.cjs`**:

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
  const nodePath = path.join(dir, "my_rust_plugin.node");
  if (fs.existsSync(nodePath)) {
    try {
      nativeModule = require(nodePath);
      if (nativeModule && Object.keys(nativeModule).length > 0) {
        module.exports = nativeModule;
        loaded = true;
        break;
      }
    } catch {
      // Continue to next path
    }
  }
}

if (!loaded) {
  module.exports = {};
}
```

### **Step 4: Create Plugin Entry Point**

**`index.ts`**:

```typescript
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "my-rust-plugin",
  name: "My Rust Plugin",
  description: "Custom Rust-powered plugin",
  configSchema: {
    parse: (value: unknown) => ({ enabled: true }),
    uiHints: {
      enabled: { label: "Enable Plugin" },
    },
  },
  async register(api: OpenClawPluginApi) {
    // Lazy-load native addon
    const nativeAddon = await import("./native/index.cjs").catch(() => null);

    if (!nativeAddon) {
      api.logger.warn("Native addon not loaded");
      return;
    }

    // Register tools
    api.registerTool({
      name: "my_greet",
      label: "Greet",
      description: "Greet someone by name",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name to greet" },
        },
        required: ["name"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { name: string };
        const result = nativeAddon.greet(p.name);
        return {
          content: [{ type: "text", text: result }],
          details: result,
        };
      },
    });

    api.registerTool({
      name: "my_add",
      label: "Add Numbers",
      description: "Add two numbers",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number", description: "First number" },
          b: { type: "number", description: "Second number" },
        },
        required: ["a", "b"],
      },
      execute: async (_toolCallId, params) => {
        const p = params as { a: number; b: number };
        const result = nativeAddon.add(p.a, p.b);
        return {
          content: [{ type: "text", text: `Result: ${result}` }],
          details: result,
        };
      },
    });
  },
});
```

### **Step 5: Build the Plugin**

```bash
cd extensions/my-rust-plugin

# Build Rust native addon
pnpm build

# This creates:
# - native/my_rust_plugin.node (compiled binary)
# - native/index.d.ts (TypeScript definitions)
```

### **Step 6: Install & Test**

```bash
# From OpenClaw root
cd /path/to/openclaw

# Install the plugin
openclaw plugins install ./extensions/my-rust-plugin

# Enable it
openclaw plugins enable my-rust-plugin

# Restart gateway
openclaw gateway restart

# Check it loaded
openclaw plugins inspect my-rust-plugin
```

---

## 🔧 **Advanced Topics**

### **Adding Async Functions**

In Rust:

```rust
use napi::Result;
use tokio::time::{sleep, Duration};

#[napi]
pub async fn async_operation(input: String) -> Result<String> {
    sleep(Duration::from_millis(100)).await;
    Ok(format!("Processed: {}", input))
}
```

In TypeScript:

```typescript
api.registerTool({
  name: "my_async_tool",
  // ...
  execute: async (_toolCallId, params) => {
    const result = await nativeAddon.asyncOperation(params.input);
    return { content: [{ type: "text", text: result }], details: result };
  },
});
```

### **Error Handling**

In Rust:

```rust
use napi::{Result, Error};

#[napi]
pub fn validate_input(input: String) -> Result<String> {
    if input.is_empty() {
        return Err(Error::from_reason("Input cannot be empty"));
    }
    Ok(input.to_uppercase())
}
```

In TypeScript:

```typescript
execute: async (_toolCallId, params) => {
  try {
    const result = nativeAddon.validateInput(params.input);
    return { content: [{ type: "text", text: result }], details: result };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      details: { error: error.message }
    };
  }
},
```

### **Working with Complex Types**

In Rust:

```rust
use napi::bindgen_prelude::*;

#[napi(object)]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
    pub is_file: bool,
}

#[napi]
pub fn get_file_info(path: String) -> FileInfo {
    // Implementation
    FileInfo {
        name: "example.txt".to_string(),
        size: 1024,
        is_file: true,
    }
}
```

### **Adding Cryptography**

Add to `Cargo.toml`:

```toml
[dependencies]
sha2 = "0.10"
aes-gcm = "0.10"
rand = "0.8"
```

In Rust:

```rust
use sha2::{Sha256, Digest};
use aes_gcm::{Aes256Gcm, KeyInit};

#[napi]
pub fn hash_data(data: String) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    hex::encode(result)
}
```

---

## 📚 **Best Practices**

### **1. Security**

- ✅ Validate all inputs
- ✅ Use bounds checking
- ✅ Handle errors properly
- ✅ Use secure crypto libraries (Argon2, AES-256-GCM)

### **2. Performance**

- ✅ Use `async` for I/O operations
- ✅ Leverage Rust's zero-copy
- ✅ Use parallel processing (Rayon)
- ✅ Avoid unnecessary allocations

### **3. Error Handling**

- ✅ Use `Result` types
- ✅ Provide meaningful error messages
- ✅ Handle edge cases
- ✅ Log errors appropriately

### **4. Testing**

- ✅ Write unit tests in Rust
- ✅ Write integration tests in TypeScript
- ✅ Test error cases
- ✅ Test with real data

---

## 🚀 **Publishing Your Plugin**

### **1. Prepare for npm**

```bash
# Build for all platforms
pnpm build

# Run tests
pnpm test

# Create .npmignore
echo "native/src/" > .npmignore
echo "native/target/" >> .npmignore
echo "*.test.ts" >> .npmignore
```

### **2. Publish to npm**

```bash
cd extensions/my-rust-plugin
npm publish
```

### **3. Users can now install**

```bash
openclaw plugins install @username/my-rust-plugin
```

---

## 📖 **Resources**

- **napi-rs**: https://napi.rs
- **OpenClaw Docs**: https://docs.openclaw.ai
- **Rust Book**: https://doc.rust-lang.org/book/
- **Tokio**: https://tokio.rs/

---

## 🎯 **Summary**

Building a Rust plugin for OpenClaw involves:

1. **Create project structure** with `package.json` and Rust code
2. **Write Rust functions** using `napi-derive`
3. **Create native module loader** (`index.cjs`)
4. **Create plugin entry point** (`index.ts`) with `definePluginEntry`
5. **Build** with `pnpm build`
6. **Install** with `openclaw plugins install`
7. **Enable** with `openclaw plugins enable`
8. **Use** in agent conversations!

The result: High-performance tools that run 5-50x faster than JavaScript! 🚀

---

**Last Updated**: 2026-03-20
**For**: OpenClaw 2026.3.14+
**Status**: Production Ready
