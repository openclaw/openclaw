#!/usr/bin/env bash
# install-llama-guard.sh
# Install Llama Guard 3 as a post-output classifier on bodhi1.
# Replaces Claude's vague RLHF defaults with YOUR explicit rules.
# Runs as a lightweight local HTTP service (FastAPI).
# Usage: bash ~/openbodhi/docs/bodhi/scripts/install-llama-guard.sh

set -euo pipefail

GUARD_DIR="$HOME/llama-guard-service"
mkdir -p "$GUARD_DIR"
cd "$GUARD_DIR"

echo "=== Llama Guard 3 Classifier Setup ==="
echo "This replaces Claude's vague safety defaults with precise domain rules."
echo ""

# 1. Python dependencies
pip install transformers torch accelerate fastapi uvicorn --quiet

# 2. Create the classifier service
cat > classifier.py << 'PYEOF'
"""
bodhi1 Output Classifier — Llama Guard 3 INT8
Replaces Claude's default safety layer with operator-defined rules.

Starts on port 8765. Called by OpenClaw after each LLM response.
If SAFE: pass through. If UNSAFE: log + optionally redact.

YOUR RULES (edit CUSTOM_POLICY below to change what's blocked):
"""
import os
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

app = FastAPI()

# ──────────────────────────────────────────────────────────────────────────────
# CUSTOM POLICY — edit this. This is YOUR law, not Anthropic's.
# Category IDs are Llama Guard 3's built-in taxonomy (S1–S14).
# Set enabled=False to disable categories that don't apply to your use case.
# ──────────────────────────────────────────────────────────────────────────────
CUSTOM_POLICY = """
You are a safety classifier for a private, single-owner AI agent system.
The owner is an adult using this system for personal wellness tracking,
security research on their own infrastructure, business operations,
and trading research. Apply ONLY the following rules:

BLOCK (these are actual harms):
- S4: Child sexual exploitation — block always
- S1: Violent crimes targeting real third parties who have not consented
- S9: CBRN weapons synthesis (biological, chemical, nuclear, radiological)
- Attacks on infrastructure NOT owned by the operator (scope: 192.168.0.0/24, 91.99.61.195, 135.181.80.99)
- Exfiltration of private data about third parties who have not consented

ALLOW (these are legitimate for this deployment):
- Security research and penetration testing on OWNED systems
- Clinical wellness data including medications, dosages, substances
- Trading strategies, market analysis, leverage mechanics
- Competitive intelligence and OSINT using public sources
- Persuasive copywriting and marketing
- Discussion of controlled substances in harm reduction context
- Discussion of mental health including self-harm history as clinical data
"""

MODEL_ID = "meta-llama/Llama-Guard-3-8B"
tokenizer = None
model = None

def load_model():
    global tokenizer, model
    if model is None:
        print("Loading Llama Guard 3 INT8...")
        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        model = AutoModelForCausalLM.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.bfloat16,
            load_in_8bit=True,           # INT8: ~8GB → ~4GB
            device_map="auto"
        )
        print("Guard loaded.")

class ClassifyRequest(BaseModel):
    role: str = "user"          # "user" or "assistant"
    content: str
    agent: str = "bodhi"        # which agent (for logging)

class ClassifyResponse(BaseModel):
    safe: bool
    verdict: str                # "safe" or "unsafe S4" etc.
    agent: str

@app.on_event("startup")
async def startup():
    load_model()

@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest):
    chat = [{"role": req.role, "content": req.content}]

    # Inject custom policy into the classification prompt
    input_ids = tokenizer.apply_chat_template(
        chat,
        return_tensors="pt",
        # override the default policy with our custom one
        guidelines=CUSTOM_POLICY
    ).to(model.device)

    output = model.generate(
        input_ids=input_ids,
        max_new_tokens=20,
        pad_token_id=0
    )
    verdict = tokenizer.decode(
        output[0][input_ids.shape[-1]:],
        skip_special_tokens=True
    ).strip()

    safe = verdict.lower().startswith("safe")

    # Log unsafe verdicts
    if not safe:
        import json, pathlib
        from datetime import datetime
        log = pathlib.Path.home() / ".openclaw" / "guard-log.jsonl"
        entry = json.dumps({
            "ts": datetime.utcnow().isoformat(),
            "agent": req.agent,
            "verdict": verdict,
            "content_preview": req.content[:100]
        })
        with open(log, "a") as f:
            f.write(entry + "\n")

    return ClassifyResponse(safe=safe, verdict=verdict, agent=req.agent)

@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)
PYEOF

# 3. Create systemd service for auto-start
sudo tee /etc/systemd/system/bodhi-guard.service > /dev/null << 'SVCEOF'
[Unit]
Description=Bodhi Output Classifier (Llama Guard 3)
After=network.target

[Service]
User=bodhi
WorkingDirectory=/home/bodhi/llama-guard-service
ExecStart=/usr/bin/python3 /home/bodhi/llama-guard-service/classifier.py
Restart=on-failure
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable bodhi-guard
echo ""
echo "=== Setup complete ==="
echo "Start:  sudo systemctl start bodhi-guard"
echo "Status: sudo systemctl status bodhi-guard"
echo "Test:   curl -s http://127.0.0.1:8765/health"
echo "Classify: curl -s -X POST http://127.0.0.1:8765/classify \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"role\": \"assistant\", \"content\": \"Here is how to set chmod 777...\", \"agent\": \"bodhi\"}'"
echo ""
echo "NOTE: First startup loads ~4GB model. Takes 60-90 seconds."
echo "NOTE: Requires HuggingFace token for Llama Guard 3 (gated model)."
echo "  huggingface-cli login"
