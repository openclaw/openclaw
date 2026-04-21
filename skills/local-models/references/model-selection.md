# GGUF file selection guide

Choose among GGUF files that already exist in the repo. Focus on ready-to-run files and the command needed to launch them.

## Contents

- Hub-first selection
- Existing GGUF variants
- Use case guide
- Model size scaling
- Finding ready-to-run repos
- Troubleshooting

## Hub-first selection

Before using generic tables, open the model repo with:

```text
https://huggingface.co/<repo>?local-app=llama.cpp
```

Prefer the exact quant labels and sizes shown in the `Hardware compatibility` section of the fetched `?local-app=llama.cpp` page text or HTML. Then confirm the matching filenames in:

```text
https://huggingface.co/api/models/<repo>/tree/main?recursive=true
```

Use the Hub page first, and only fall back to the generic heuristics below when the repo page does not expose a clear recommendation.

## Existing GGUF variants

**GGUF** is the standard format for llama.cpp models.

| Format | Typical 7B size | Notes |
|--------|-----------------|-------|
| `Q8_0` | 7.0 GB | Nearly lossless, large |
| `Q6_K` | 5.5 GB | Best quality/size if memory allows |
| `Q5_K_M` | 4.8 GB | Balanced, strong for code |
| `Q4_K_M` | 4.1 GB | Default pick for most users |
| `Q4_K_S` | 3.9 GB | Faster, slightly lower quality |
| `Q3_K_M` | 3.3 GB | Use for tighter RAM or VRAM budgets |
| `Q2_K` | 2.7 GB | Only for very constrained devices |

If the repo ships multiple K-quant variants:

- `_S` is smaller and faster
- `_M` is the normal balanced pick
- `_L` is larger and higher quality

Keep repo-native labels such as `UD-Q4_K_M` or `IQ4_XS` exactly as the repo shows them.

## Use case guide

### General chat and assistant use

```text
Q4_K_M - Best default
Q5_K_M - If the user has extra RAM or VRAM
```

### Code generation

```text
Q5_K_M or Q6_K - Higher precision helps
```

### Creative writing or brainstorming

```text
Q4_K_M - Usually enough
Q3_K_M - Acceptable when memory is tight
```

### Technical or high-accuracy use

```text
Q6_K or Q8_0 - If the hardware can absorb it
```

### Edge devices

```text
Q2_K or Q3_K_M - Only when the user has very limited RAM
```

## Model size scaling

### 7B parameter models

| Format | Size | RAM needed |
|--------|------|------------|
| `Q2_K` | 2.7 GB | 5 GB |
| `Q3_K_M` | 3.3 GB | 6 GB |
| `Q4_K_M` | 4.1 GB | 7 GB |
| `Q5_K_M` | 4.8 GB | 8 GB |
| `Q6_K` | 5.5 GB | 9 GB |
| `Q8_0` | 7.0 GB | 11 GB |

### 13B parameter models

| Format | Size | RAM needed |
|--------|------|------------|
| `Q2_K` | 5.1 GB | 8 GB |
| `Q3_K_M` | 6.2 GB | 10 GB |
| `Q4_K_M` | 7.9 GB | 12 GB |
| `Q5_K_M` | 9.2 GB | 14 GB |
| `Q6_K` | 10.7 GB | 16 GB |

### 70B parameter models

| Format | Size | RAM needed |
|--------|------|------------|
| `Q2_K` | 26 GB | 32 GB |
| `Q3_K_M` | 32 GB | 40 GB |
| `Q4_K_M` | 41 GB | 48 GB |
| `Q4_K_S` | 39 GB | 46 GB |
| `Q5_K_M` | 48 GB | 56 GB |

For 70B-class models on consumer hardware, start by checking whether the repo or local-app page already recommends a smaller runnable variant.

## Finding ready-to-run repos

Use the Hub search with the llama.cpp app filter:

```text
https://huggingface.co/models?apps=llama.cpp&sort=trending
https://huggingface.co/models?search=<term>&apps=llama.cpp&sort=trending
https://huggingface.co/models?search=<term>&apps=llama.cpp&num_parameters=min:0,max:24B&sort=trending
```

For a specific repo, open:

```text
https://huggingface.co/<repo>?local-app=llama.cpp
https://huggingface.co/api/models/<repo>/tree/main?recursive=true
```

Then launch directly from the Hub without extra Hub tooling:

```bash
llama-cli -hf <repo>:Q4_K_M
llama-server -hf <repo>:Q4_K_M
```

If you need the exact file name from the tree API:

```bash
llama-server --hf-repo <repo> --hf-file <filename.gguf>
```

## Troubleshooting

**Model outputs gibberish**:

- The chosen GGUF may be too aggressive for the task
- Try `Q4_K_M`, `Q5_K_M`, or the exact HF-recommended variant
- Verify the model family and instruct template are correct for the repo

**Out of memory**:

- Use a smaller existing GGUF such as `Q4_K_S` instead of `Q5_K_M`
- Offload fewer layers to GPU with `-ngl`
- Use a smaller context such as `-c 2048`

**Slow inference**:

- Larger existing GGUFs use more compute
- `Q8_0` is much slower than `Q4_K_M`
- Consider a smaller model family or a lighter GGUF file
