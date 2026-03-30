# Sense freeform investigation

## Current finding

- `openclaw agent --local ...` does **not** expose plugin tools.
- The reason is structural: `--local` routes through `runCliAgent()` in `src/agents/cli-runner.ts`.
- That runner hard-codes:
  - `Tools are disabled in this session. Do not call tools.`
  - `systemPromptReport.tools = []`

## Impact

- `sense-worker` can be loaded and allowed for `ops`, while still never appearing in a `--local` freeform turn.
- This is not a `sense-worker` registration failure.
- It is a runner-path mismatch between:
  - CLI local runner
  - embedded tool-capable runner

## Safe repro path

- Use `scripts/dev/sense_freeform_embedded.ts` for a tool-capable freeform turn.
- Success path:
  - `pnpm sense:freeform -- --input "OpenClaw should offload this summary to Sense."`
- Fallback path:
  - `pnpm sense:freeform -- --sense-base-url http://192.168.11.11:9999 --input "Fallback should stay readable when Sense is unavailable."`

## Permanent fix direction

1. Keep `--local` semantics unchanged if it is intentionally CLI-backed.
2. Add a separate embedded freeform flag or command for tool-capable local runs.
3. For agent configs that use `tools.profile`, use `tools.alsoAllow` for additive plugin tools.
4. Do **not** rely on `tools.allow` to extend a restrictive profile like `minimal`; it intersects with the profile and will hide plugin tools such as `sense-worker`.
5. Update the CLI help text so users do not expect plugin tools inside the CLI-backed `--local` path.

## Stable Deepnoa operating shape

- OpenClaw:
  - orchestrator
  - chooses when to offload
  - owns fallback behavior
- Sense worker:
  - remote execution entrypoint
  - receives authenticated `execute` requests
  - dispatches tasks such as `summarize` and `generate_draft`
- future worker internals:
  - Ollama
  - NemoClaw
  - heavy text / file / GPU tasks

## Auth note

- Recommended env var on T550: `SENSE_WORKER_TOKEN`
- The OpenClaw adapter and helper workflows send `X-Sense-Worker-Token` when this env var is present.
- Worker-side verification should return `401` on mismatch.
