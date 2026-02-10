---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: openai-image-gen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Batch-generate images via OpenAI Images API. Random prompt sampler + `index.html` gallery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://platform.openai.com/docs/api-reference/images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🖼️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["python3"], "env": ["OPENAI_API_KEY"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primaryEnv": "OPENAI_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "python-brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "python",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["python3"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install Python (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenAI Image Gen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generate a handful of “random but structured” prompts and render them via the OpenAI Images API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
open ~/Projects/tmp/openai-image-gen-*/index.html  # if ~/Projects/tmp exists; else ./tmp/...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Useful flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# GPT image models with various options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py --count 16 --model gpt-image-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py --prompt "ultra-detailed studio photo of a lobster astronaut" --count 4（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py --size 1536x1024 --quality high --out-dir ./out/images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py --model gpt-image-1.5 --background transparent --output-format webp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# DALL-E 3 (note: count is automatically limited to 1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py --model dall-e-3 --quality hd --size 1792x1024 --style vivid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py --model dall-e-3 --style natural --prompt "serene mountain landscape"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# DALL-E 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python3 {baseDir}/scripts/gen.py --model dall-e-2 --size 512x512 --count 4（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model-Specific Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Different models support different parameter values. The script automatically selects appropriate defaults based on the model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GPT image models** (`gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`): `1024x1024`, `1536x1024` (landscape), `1024x1536` (portrait), or `auto`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: `1024x1024`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **dall-e-3**: `1024x1024`, `1792x1024`, or `1024x1792`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: `1024x1024`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **dall-e-2**: `256x256`, `512x512`, or `1024x1024`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: `1024x1024`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Quality（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GPT image models**: `auto`, `high`, `medium`, or `low`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: `high`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **dall-e-3**: `hd` or `standard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: `standard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **dall-e-2**: `standard` only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: `standard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Other Notable Differences（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **dall-e-3** only supports generating 1 image at a time (`n=1`). The script automatically limits count to 1 when using this model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GPT image models** support additional parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--background`: `transparent`, `opaque`, or `auto` (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--output-format`: `png` (default), `jpeg`, or `webp`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Note: `stream` and `moderation` are available via API but not yet implemented in this script（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **dall-e-3** has a `--style` parameter: `vivid` (hyper-real, dramatic) or `natural` (more natural looking)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `*.png`, `*.jpeg`, or `*.webp` images (output format depends on model + `--output-format`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prompts.json` (prompt → file mapping)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `index.html` (thumbnail gallery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
