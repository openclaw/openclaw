---
title: "Rust Plugin Template"
summary: "High-performance OpenClaw plugin built with Rust using napi-rs"
---

# Rust Plugin Template

This is a template for building high-performance OpenClaw plugins using Rust.

## Why Rust?

- **Performance**: Native speed for compute-intensive operations
- **Safety**: Memory safety guaranteed by Rust
- **Concurrency**: Excellent async support via tokio
- **Ecosystem**: Access to crates.io libraries

## Installation

```bash
# Build the native addon
cd extensions/rust-plugin
pnpm install
pnpm build
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "rust-plugin": {
        "enabled": true,
        "config": {
          "option1": "value",
          "numericOption": 42
        }
      }
    }
  }
}
```

## Available Tools

| Tool           | Description                                             |
| -------------- | ------------------------------------------------------- |
| `rust_compute` | Process strings with options (uppercase, reverse, trim) |
| `rust_hash`    | Compute hashes using SHA256, SHA512, or BLAKE3          |

## Example Usage

### Through the agent

```
User: use rust_hash to compute the SHA256 of "hello world"
Agent: [calls rust_hash tool]
Result: a948904f2f0f0722d4cf1a8b0d3e2e3b4c2f1b0e5e2d3a86e5e4f4
```

### Through CLI

```bash
openclaw agent --message "Compute BLAKE3 hash of 'test data' using rust_hash with blake3 algorithm"
```

## Extending the Plugin

Add functions in `native/src/lib.rs`:

```rust
#[napi]
pub fn my_custom_function(input: String) -> Result<String> {
    Ok(format!("Processed: {}", input))
}
```

Register in `index.ts`:

```typescript
api.registerTool({
  name: "my_custom_tool",
  description: "My custom tool",
  parameters: {
    /* ... */
  },
  execute: async (params) => {
    const result = await nativeAddon.myCustomFunction(params.input);
    return { success: true, result };
  },
});
```
