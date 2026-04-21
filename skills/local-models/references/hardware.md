## Hardware acceleration

### Apple Silicon (Metal)

```bash
make clean && make GGML_METAL=1
llama-cli -m model.gguf -ngl 99 -p "Hello"
```

### NVIDIA (CUDA)

```bash
make clean && make GGML_CUDA=1
llama-cli -m model.gguf -ngl 35 -p "Hello"

# Hybrid for large models
llama-cli -m llama-70b.Q4_K_M.gguf -ngl 20

# Multi-GPU split
llama-cli -m large-model.gguf --tensor-split 0.5,0.5 -ngl 60
```

### AMD (ROCm)

```bash
make LLAMA_HIP=1
llama-cli -m model.gguf -ngl 999
```

### CPU

```bash
# Match physical cores, not logical threads
llama-cli -m model.gguf -t 8 -p "Hello"

# BLAS acceleration
make LLAMA_OPENBLAS=1
```
