#!/usr/bin/env bash
# convert-gguf-to-mlx.sh — Generic GGUF → MLX format converter
# Uses mlx-lm to convert any GGUF model (Mistral, Llama, Qwen, etc.) to MLX format.
# Safe for parallel execution (each run uses its own output directory).
#
# Requirements: Python 3.10+, mlx-lm (pip install mlx-lm), Apple Silicon Mac
#
# Usage:
#   ./convert-gguf-to-mlx.sh <input.gguf> [output_dir] [--quantize Q4_K_M]
#
# Examples:
#   ./convert-gguf-to-mlx.sh mistral-7b-v0.3.Q4_K_M.gguf
#   ./convert-gguf-to-mlx.sh llama-3.1-8b.gguf ./mlx-models/llama-8b
#   ./convert-gguf-to-mlx.sh qwen2-7b.gguf ./out --quantize Q4_K_M
#
# Parallel usage (convert multiple models at once):
#   for f in *.gguf; do ./convert-gguf-to-mlx.sh "$f" "./mlx-$(basename "$f" .gguf)" & done; wait

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()   { error "$@"; exit 1; }

# ── Usage ───────────────────────────────────────────────────────────────────
usage() {
    cat <<'EOF'
Usage: convert-gguf-to-mlx.sh <input.gguf> [output_dir] [--quantize TYPE]

Arguments:
  input.gguf       Path to the GGUF model file
  output_dir       Output directory (default: ./mlx-<model_name>)

Options:
  --quantize TYPE  Post-conversion quantization (e.g., Q4_K_M, Q8_0)
  -h, --help       Show this help message

Supported models: Mistral, Llama, Qwen, Phi, Gemma, and any GGUF-compatible architecture.
EOF
    exit 0
}

# ── Parse arguments ─────────────────────────────────────────────────────────
INPUT_GGUF=""
OUTPUT_DIR=""
QUANTIZE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)     usage ;;
        --quantize)    QUANTIZE="${2:?'--quantize requires a type (e.g., Q4_K_M)'}"; shift 2 ;;
        -*)            die "Unknown option: $1" ;;
        *)
            if [[ -z "$INPUT_GGUF" ]]; then
                INPUT_GGUF="$1"
            elif [[ -z "$OUTPUT_DIR" ]]; then
                OUTPUT_DIR="$1"
            else
                die "Unexpected argument: $1"
            fi
            shift ;;
    esac
done

[[ -n "$INPUT_GGUF" ]] || { usage; }

# ── Validate input ──────────────────────────────────────────────────────────
[[ -f "$INPUT_GGUF" ]] || die "Input file not found: $INPUT_GGUF"
[[ "$INPUT_GGUF" == *.gguf ]] || warn "Input file does not have .gguf extension — proceeding anyway"

# Default output directory
if [[ -z "$OUTPUT_DIR" ]]; then
    MODEL_NAME="$(basename "$INPUT_GGUF" .gguf)"
    OUTPUT_DIR="./mlx-${MODEL_NAME}"
fi

# ── Check dependencies ──────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
    die "python3 is required but not found"
fi

if ! python3 -c "import mlx_lm" 2>/dev/null; then
    die "mlx-lm is not installed. Install with: pip install mlx-lm"
fi

# ── Prepare output directory ────────────────────────────────────────────────
if [[ -d "$OUTPUT_DIR" ]]; then
    warn "Output directory already exists: $OUTPUT_DIR"
    warn "Files may be overwritten."
fi
mkdir -p "$OUTPUT_DIR"

# ── Convert ─────────────────────────────────────────────────────────────────
info "Converting: $INPUT_GGUF"
info "Output:     $OUTPUT_DIR"

CONVERT_ARGS=(
    -m "$INPUT_GGUF"
    --mlx-path "$OUTPUT_DIR"
)

if [[ -n "$QUANTIZE" ]]; then
    CONVERT_ARGS+=(-q --q-bits "${QUANTIZE}")
    info "Quantization: $QUANTIZE"
fi

info "Running: python3 -m mlx_lm.convert ${CONVERT_ARGS[*]}"
echo ""

if python3 -m mlx_lm.convert "${CONVERT_ARGS[@]}"; then
    echo ""
    info "✅ Conversion complete!"
    info "Output directory: $OUTPUT_DIR"
    info "Contents:"
    ls -lh "$OUTPUT_DIR"
else
    EXIT_CODE=$?
    die "Conversion failed (exit code: $EXIT_CODE)"
fi
