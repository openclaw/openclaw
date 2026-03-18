# Sense Worker Token Auth Handoff

## Current state

- T550 / OpenClaw now sends `X-Sense-Worker-Token` when `SENSE_WORKER_TOKEN` is set.
- The live Sense worker at `http://192.168.11.11:8787` is reachable over LAN.
- `GET /health` is currently public.
- `POST /execute` currently accepts requests even with a wrong token, so worker-side verification is not yet enabled.

## Recommended policy

- `GET /health`
  - keep unauthenticated
  - use for liveness / LAN reachability only
- `POST /execute`
  - require `X-Sense-Worker-Token`
  - compare against `SENSE_WORKER_TOKEN`
  - return `401` with JSON body on mismatch

## Target error response

```json
{
  "status": "error",
  "error": "unauthorized"
}
```

## FastAPI implementation sketch

```python
import os
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()


def verify_token(x_sense_worker_token: str | None) -> None:
    expected = os.environ.get("SENSE_WORKER_TOKEN", "").strip()
    if not expected:
        # Development-only fallback: allow requests when no token is configured.
        return
    if x_sense_worker_token != expected:
        raise HTTPException(
            status_code=401,
            detail={"status": "error", "error": "unauthorized"},
        )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/execute")
def execute(
    payload: dict,
    x_sense_worker_token: str | None = Header(default=None, alias="X-Sense-Worker-Token"),
):
    verify_token(x_sense_worker_token)
    task = payload.get("task", "")
    input_text = payload.get("input", "")
    params = payload.get("params", {}) or {}

    if task == "summarize":
        return {
            "status": "ok",
            "result": f"Sense summary: {input_text}",
            "meta": {"node": "sense"},
        }

    if task == "generate_draft":
        return {
            "status": "ok",
            "result": (
                "ご連絡ありがとうございます。"
                "内容を確認のうえ、担当より折り返しご案内いたします。"
            ),
            "meta": {"node": "sense"},
        }

    return {
        "status": "ok",
        "result": (
            f"Sense worker received task={task!r} "
            f"with {len(input_text)} input characters and {len(params)} params."
        ),
        "meta": {"node": "sense"},
    }
```

## Verification commands after worker-side patch

```bash
curl http://192.168.11.11:8787/health

curl -X POST http://192.168.11.11:8787/execute \
  -H "Content-Type: application/json" \
  -H "X-Sense-Worker-Token: $SENSE_WORKER_TOKEN" \
  -d '{"task":"summarize","input":"This is a test from T550","params":{}}'

curl -i -X POST http://192.168.11.11:8787/execute \
  -H "Content-Type: application/json" \
  -H "X-Sense-Worker-Token: wrong-token" \
  -d '{"task":"summarize","input":"wrong token probe","params":{}}'
```

## Expected OpenClaw behavior after patch

- `pnpm sense:summarize` with correct token:
  - success
- `pnpm sense:draft` with correct token:
  - success
- wrong token:
  - remote returns `401`
  - plugin logs the remote failure
  - helper workflow can still fall back locally

## Notes

- This document is a handoff because the Sense worker source is not present in the T550 workspace.
- Apply the patch on the Windows / Sense worker repo, then re-run the verification from T550.
