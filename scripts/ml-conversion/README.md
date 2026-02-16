# GGUF → MLX Converter

Generic script to convert any GGUF model to Apple MLX format using `mlx-lm`.

## Requirements

- Apple Silicon Mac (M1/M2/M3/M4)
- Python 3.10+
- `mlx-lm`: `pip install mlx-lm`

## Usage

```bash
# Basic conversion
./convert-gguf-to-mlx.sh model.gguf

# Specify output directory
./convert-gguf-to-mlx.sh model.gguf ./my-mlx-model

# With quantization
./convert-gguf-to-mlx.sh model.gguf ./out --quantize Q4_K_M

# Parallel batch conversion
for f in *.gguf; do
  ./convert-gguf-to-mlx.sh "$f" "./mlx-$(basename "$f" .gguf)" &
done
wait
```

## Supported Models

Works with any GGUF model: Mistral, Llama, Qwen, Phi, Gemma, etc.

## What It Does

1. Validates the input GGUF file exists
2. Checks `mlx-lm` is installed
3. Runs `python3 -m mlx_lm.convert` with the provided arguments
4. Reports success/failure with colored output
