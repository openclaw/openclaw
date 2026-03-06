## Summary

Fixes issue #36871 - CLI and config path parser incorrectly splits custom provider keys containing periods (e.g. llama.cpp).

## Changes

The `parseConfigPath` function in `src/config/config-paths.ts` now supports bracket notation:

- `models.providers["llama.cpp"].baseUrl` → ["models", "providers", "llama.cpp", "baseUrl"]
- `models.providers['llama.cpp'].baseUrl` → ["models", "providers", "llama.cpp", "baseUrl"]
- `providers[key].value` → ["providers", "key", "value"]

This allows configuring providers with periods in their names.

## Test Results

All unit tests pass. Manual tests confirm the fix works as expected.

## Breaking Change

None - the change is backwards compatible. Standard dot notation (e.g., foo.bar.baz) still works as before.
