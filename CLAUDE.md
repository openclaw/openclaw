# Fork-specific notes

- This is a fork of openclaw/openclaw deployed on Railway at agent.hypertransient.com.
- Do NOT modify upstream source files (src/**, docs/**, etc.) — only deployment config.
- Railway auto-assigns the PORT env var. Do not override it manually.
- Railway's builder does NOT support BuildKit `--mount=type=cache` directives. After syncing upstream, strip them from the Dockerfile.
- The "update available" message in gateway logs is expected — updates happen by syncing the fork and rebuilding, not via the control UI.

## Dockerfile — Railway-required changes

After every upstream sync, ensure the Dockerfile CMD and HEALTHCHECK are correct for Railway:

```dockerfile
HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.PORT||18789;fetch('http://127.0.0.1:'+p+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node --max-old-space-size=4096 openclaw.mjs gateway --bind lan --port ${PORT:-18789} --allow-unconfigured"]
```

Key differences from upstream:
- `--bind lan` (upstream uses loopback — Railway needs 0.0.0.0)
- `--port ${PORT:-18789}` (upstream hardcodes or omits — Railway assigns PORT)
- Healthcheck reads `process.env.PORT` (upstream hardcodes 18789)

## Syncing from upstream

1. On GitHub: "Sync fork" or merge upstream/main into your main
2. Resolve conflicts by accepting upstream — unless it's a file you intentionally changed for Railway
3. **Check the Dockerfile** for `--mount=type=cache` lines and remove them (Railway rejects these)
4. **Check the Dockerfile CMD and HEALTHCHECK** — restore `--bind lan` and PORT handling if upstream overwrote them
5. Push main, Railway rebuilds automatically
