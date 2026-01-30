#!/usr/bin/env node

// Print deprecation warning to stderr so it doesn't interfere with command output
console.error("\x1b[33m⚠️  Warning: 'moltbot' has been renamed to 'openclaw'\x1b[0m");
console.error("\x1b[33mThis compatibility shim will be removed in a future version.\x1b[0m");
console.error("\x1b[33mPlease reinstall:\x1b[0m");
console.error("\x1b[36m  npm uninstall -g moltbot\x1b[0m");
console.error("\x1b[36m  npm install -g openclaw@latest\x1b[0m");
console.error("");

// Forward to openclaw CLI entry point
await import("openclaw/cli-entry");
