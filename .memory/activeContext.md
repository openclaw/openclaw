# Active Context - OpenClaw System Fix

## Sprint Goal

- Isolate OpenClaw from `~/.openclaw` and move everything to `/home/vova/OpenPro`.
- Fix `memory-hybrid` plugin to work with local LanceDB.

## 🧠 Memory-Hybrid Plugin Fix (Mar 2, 2026)

- **Problem**: Dimension mismatch (code expected 768, model sent 3072).
- **Fix**: Updated `EMBEDDING_DIMENSIONS` for `gemini-embedding-001` to **3072** in `embeddings.ts`.
- **Status**: Fixed. Database recreated, autoCapture/smartCapture enabled, rate limits mitigated with delay.
- **Verification**: `ltm stats` and `ltm search` work correctly.

## Immediate Next Steps

- [x] Fix GEMINI_API_KEY env var in systemd
- [x] Fix Dimension Mismatch: Update code to 3072 and recreate table
- [x] Optimize rate limiting for smart capture
- [ ] Monitor memory capture during natural conversation with Vova in config.

5. [x] Patched `message-handler.ts` to allow scopes in dangerous auth mode (Fixed the empty chat issue).
6. [x] Updated service PATH to include `.local/bin` for pnpm rebuilds.
7. [x] Verified successful connection and scope access in logs.
8. [x] Fixed "No API key" agent error by switching to direct API key auth.
9. [x] Fixed "Dimension mismatch: 3072" by wiping DB and standardizing models (Gemini 1.5 Flash + text-embedding-004).
10. [x] Updated memory-hybrid code and manifest to support text-embedding-004.
