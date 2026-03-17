---
name: seedream
description: Generate high-quality images from text prompts using BytePlus Seedream models. Supports multiple artistic styles and aspect ratios. Use this skill when users want to create images from text descriptions, generate artwork in various styles, create visual content for creative projects, or need AI-powered image generation capabilities.
license: Apache-2.0
tags: ["image-generation", "seedream", "byteplus", "ai-art", "text-to-image", "image-to-image"]
---

# seedream

## Description

Generate high-quality images from text prompts using BytePlus Seedream models. This skill provides access to three powerful Seedream model versions (4.0, 4.5, and 5.0), each offering unique capabilities for different use cases.

## When to Use This Skill

Use this skill when:
- Users want to create images from text descriptions
- Users need to generate artwork in various artistic styles
- Users want to create visual content for creative projects
- Users need AI-powered image generation capabilities
- Users want to convert reference images to different styles
- Users need to generate multiple images in batch
- Users require high-quality, professional-looking images

## Model Versions

| Version | Model Name | Release Date | Recommendation | Best For |
|---------|------------|--------------|----------------|----------|
| 4.0 | seedream-4-0-250828 | August 2025 | ⭐⭐⭐ | Daily use, quick generation |
| 4.5 | seedream-4-5-251128 | November 2025 | ⭐⭐⭐⭐ | Detail-oriented work, complex scenes |
| 5.0 | seedream-5-0-260128 | 2026 | ⭐⭐⭐⭐⭐ | Highest quality, best creativity, tools support |

## Features

- **Text-to-Image**: Generate images from detailed text descriptions
- **Image-to-Image**: Transform reference images into different styles
- **Batch Generation**: Create multiple images in a single request
- **Multiple Versions**: Choose from 4.0, 4.5, or 5.0 models
- **Watermark Control**: Option to disable watermarks
- **Custom Sizes**: Support for various image dimensions
- **Output Formats**: PNG and JPEG formats (5.0 only)
- **Web Search Tools**: Internet search integration (5.0 only)

## Installation & Setup

### Prerequisites

```bash
# Required: API Key configuration
export ARK_DOLA_API_KEY="your-api-key-here"

# Optional: API Base URL (default already configured)
export ARK_DOLA_API_BASE="https://ark.ap-southeast.bytepluses.com/api/v3"
```

## Usage

### Basic Usage (5.0 version recommended)

```bash
cd scripts
python seedream_image_generate.py -p "A cute kitten playing in a garden"
```

### Specify Version

```bash
# Use 4.0 version
python seedream_image_generate.py -p "A cute kitten" --version 4.0

# Use 4.5 version
python seedream_image_generate.py -p "A cute kitten" --version 4.5

# Use 5.0 version (recommended)
python seedream_image_generate.py -p "A cute kitten" --version 5.0
```

### Advanced Options

```bash
# Custom size without watermark
python seedream_image_generate.py -p "Beautiful sunset" -s 2048x2048 --no-watermark --version 5.0

# Batch generation
python seedream_image_generate.py -p "Generate 3 cute dog pictures" -g --max-images 3 --version 4.5

# Image-to-image
python seedream_image_generate.py -p "Convert this image to anime style" -i "https://example.com/image.jpg" --version 5.0

# Web search tool (5.0-lite only)
python seedream_image_generate.py -p "Latest 2026 smartphone" --web-search --version 5.0

# Custom output format (5.0-lite only)
python seedream_image_generate.py -p "A beautiful landscape" --output-format png --version 5.0

# List all supported versions
python seedream_image_generate.py --list-versions
```

## Command Line Options

| Option | Shortcut | Description | Default |
|--------|----------|-------------|---------|
| `--prompt` | `-p` | Image description text (required) | - |
| `--version` | `-v` | Version selection: `4.0`, `4.5`, `5.0` | `5.0` |
| `--size` | `-s` | Image dimensions | `2048x2048` |
| `--image` | `-i` | Single reference image URL | - |
| `--images` | - | Multiple reference image URLs (space separated) | - |
| `--group` | `-g` | Enable batch image generation | `false` |
| `--max-images` | - | Maximum images for batch generation | `15` |
| `--output-format` | - | Output format: `png` or `jpeg` (5.0 only) | `jpeg` |
| `--response-format` | - | Response format: `url` or `b64_json` | `url` |
| `--stream` | - | Enable streaming output | `false` |
| `--web-search` | - | Enable web search tool (5.0 only) | `false` |
| `--optimize-prompt-mode` | - | Prompt optimization mode: `standard` or `fast` | - |
| `--timeout` | `-t` | Timeout in seconds | `1200` |
| `--no-watermark` | - | Disable watermark | `false` |
| `--list-versions` | - | List all supported versions | - |

## Python API Usage

```python
import asyncio
import sys

sys.path.append("scripts")
from seedream_image_generate import seedream_generate

async def main():
    # Use 5.0-lite version (default)
    result = await seedream_generate([
        {
            "prompt": "A cute kitten",
            "size": "2048x2048",
            "watermark": False,
            "output_format": "png"  # 5.0-lite only
        }
    ], version="5.0")
    
    print(result)

asyncio.run(main())
```

## Version Selection Guide

### Choose 4.0 if:
- You need quick daily generation
- Quality requirements are not extremely high
- You need faster generation speed
- Simple scenes and styles

### Choose 4.5 if:
- You want richer details
- You're working with complex scenes
- You need better style reproduction
- You have moderate quality requirements

### Choose 5.0-lite (Recommended) if:
- You want the highest quality
- You need breakthrough creative expression
- You have extreme detail requirements
- **You need tools parameter (like web search)** ⭐
- **You need custom output format (png/jpeg)** ⭐
- Important projects and work

**When in doubt, use 5.0-lite!** ⭐

## Prompt Engineering Tips

### Basic Prompt Structure
```
[Subject Description] + [Style/Art Movement] + [Lighting/Atmosphere] + [Quality/Resolution]
```

### Advanced Prompts (Optimized for 5.0-lite)
```
[Subject Description], [Creative Style/Art Movement], [Unique Perspective/Composition], [Special Lighting/Atmosphere], [Emphasizing 5.0-lite creative expression]
```

## Parameter Support by Version

| Parameter | Seedream 4.0 | Seedream 4.5 | Seedream 5.0-lite | Description |
|-----------|--------------|--------------|-------------------|-------------|
| model | ✅ | ✅ | ✅ | Model name |
| prompt | ✅ | ✅ | ✅ | Prompt (required) |
| image | ✅ | ✅ | ✅ | Reference image(s) |
| size | ✅ | ✅ | ✅ | Image dimensions |
| sequential_image_generation | ✅ | ✅ | ✅ | Batch generation control |
| sequential_image_generation_options | ✅ | ✅ | ✅ | Batch generation config |
| response_format | ✅ | ✅ | ✅ | Response format (url/b64_json) |
| watermark | ✅ | ✅ | ✅ | Watermark (true/false) |
| stream | ✅ | ✅ | ✅ | Streaming output |
| optimize_prompt_options | ✅ | ✅ | ✅ | Prompt optimization config |
| **tools** | ❌ | ❌ | **✅** | Tool configuration (5.0-lite only) |
| **output_format** | ❌ | ❌ | **✅** | Output format (png/jpeg, 5.0-lite only) |

## FAQ

### Q: What's the difference between the versions?
A: 4.0 is for quick daily use, 4.5 offers better details for complex scenes, and 5.0-lite provides the highest quality with unique tools support.

### Q: How long are generated URLs valid?
A: URLs are valid for 24 hours. Please download and save your images promptly.

### Q: What image formats are supported for references?
A: Common formats like JPG and PNG are supported, provided via URL or Base64.

### Q: Can I use multiple versions in one call?
A: Currently, only one version per call. For comparisons, make separate calls for different versions.

## License

This skill is licensed under the Apache License 2.0. See the LICENSE file for details.

## Notice

Please comply with BytePlus's terms of service and relevant laws and regulations when using this skill.
