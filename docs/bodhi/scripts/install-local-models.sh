#!/usr/bin/env bash
# install-local-models.sh
# Pull unrestricted local models for routing tasks Claude over-refuses.
# Run once on bodhi1. GTX 1070 = 8GB VRAM.
# Usage: bash ~/openbodhi/docs/bodhi/scripts/install-local-models.sh

set -euo pipefail

echo "=== Local Model Setup for bodhi1 ==="
echo "GPU: GTX 1070 (8GB VRAM)"
echo ""

# 1. Dolphin3 — dataset-cleaned Llama 3.1 8B, ~4.9GB, fits in VRAM cleanly
# No RLHF refusal layer. Full compliance. You supply all guardrails.
echo "[1/3] Pulling dolphin3 (Llama 3.1 8B, 4.9GB)..."
ollama pull dolphin3

# 2. Dolphin Mistral Nemo 12B — more capable, needs CPU offload on 1070
# Q4_K_M = 7.7GB — exceeds VRAM, will use partial CPU offloading
# Slower but better reasoning for complex tasks
echo "[2/3] Pulling dolphin-mistral-nemo:12b-2407-q4_K_M (7.7GB, partial CPU offload)..."
ollama pull dolphin-mistral-nemo:12b-2407-q4_K_M || echo "  (skip if disk space constrained — dolphin3 covers most cases)"

# 3. nomic-embed-text — embeddings, already pulled per Phase 1
echo "[3/3] Verifying nomic-embed-text..."
ollama pull nomic-embed-text

echo ""
echo "=== Installed models ==="
ollama list

echo ""
echo "=== Test dolphin3 compliance ==="
echo "Run: ollama run dolphin3 'Explain in detail how a buffer overflow exploit works'"
echo "Expected: full technical answer, no refusal"
echo ""
echo "=== Routing in OpenClaw ==="
echo "To route a task to dolphin3 instead of Claude:"
echo "  In SKILL.md: specify 'model: ollama/dolphin3' in the skill frontmatter"
echo "  Or: set agent model to 'ollama/dolphin3' via /model command"
