## Summary

- **Follow redirects when downloading Twilio media** - Media downloads now properly handle 3xx redirects (up to 5 hops), fixing issues with media providers that redirect URLs
- **Fix media serving and ID consistency** - Media files now saved with correct extensions based on MIME type detection via content sniffing
- **Use `export type` for type-only re-exports** - TypeScript best practice fix
- **User-agnostic Claude identity** - Refactored identity prefix handling with tests
- **Send Claude identity prefix on first session message** - Identity injection now respects `sendSystemOnce` and `systemSent` flags

## Test plan

- [x] Existing tests pass
- [x] Media download redirect handling tested
- [x] MIME detection and extension handling covered

🤖 Generated with [Claude Code](https://claude.com/claude-code)
