# Smart Agent Neo

Personal AI assistant platform with Morpheus decentralized inference as a first-class provider.

## Project Structure

See `AGENTS.md` for project guidelines (module layout, testing conventions, docs linking, etc.).

Key additions:

- `src/agents/morpheus-models.ts` - Morpheus model catalog + blockchain discovery
- `src/agents/morpheus-proxy.ts` - Session-aware proxy bridge to Morpheus proxy-router
- `src/agents/models-config.providers.ts` - Modified to include Morpheus as implicit provider
- `docs/providers/morpheus.md` - Morpheus provider setup guide

## Morpheus Integration

Morpheus is a **first-class inference provider** (alongside Anthropic, OpenAI, Venice, Ollama). It routes requests through the Morpheus proxy-router for decentralized AI inference on the Morpheus network.

Key fixes baked into the integration:
1. Never use `maxUint256` with `increaseAllowance` (Solidity overflow panic 0x11)
2. Dynamic model IDs from blockchain API (not hardcoded hex values)
3. Correct decimal handling for session economics (wei display was 1000x off)
4. Auto-session management with renewal before expiry
5. Billing-aware error classification

## Conventions

- Follow conventions in `AGENTS.md`
- No AI attributions in commits, PRs, or code
- Morpheus provider code follows the Venice/Together provider pattern in `src/agents/`
