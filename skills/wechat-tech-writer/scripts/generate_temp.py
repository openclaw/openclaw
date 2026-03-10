#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时图片生成脚本，避免emoji输出问题"""
import sys
import os

# 添加脚本目录到路径
sys.path.insert(0, os.path.dirname(__file__))

from generate_image import GeminiImageGenerator

def generate_cover():
    """生成封面图"""
    prompt = """A modern, professional cover image for Claude Skills technology article.
Design features a gradient background from deep blue (#1a1f5c) to purple (#7c3aed).
In center, floating modular 3D blocks representing different skills, each block labeled in simplified Chinese:
'文档处理' (Document Processing), '代码审查' (Code Review), '数据分析' (Data Analysis).
Blocks are connected by glowing blue lines suggesting interconnectivity.
At the top, large bold text 'Claude Skills' with Chinese subtitle '让AI秒变领域专家' (Turn AI into Domain Experts).
Style: minimalist, tech-forward, professional, clean.
All text in simplified Chinese, minimal text, clear and accurate.
16:9 aspect ratio, high quality."""

    output_path = r"G:\git_pull\微信公众号文章\AI提效系列\claude_skills_cover.png"

    try:
        print("Generating cover image...")
        generator = GeminiImageGenerator()
        result = generator.generate(prompt, output_path)
        print(f"Success: {result}")
        return 0
    except Exception as e:
        print(f"Error: {str(e)}")
        return 1

def generate_architecture():
    """生成架构图"""
    prompt = """A technical architecture diagram illustrating the three-layer loading mechanism of Claude Skills.
The diagram shows three horizontal layers stacked vertically with distinct colors:
- Top layer in light blue (#60a5fa) labeled '元数据层 ~100词' (Metadata Layer ~100 words)
- Middle layer in medium blue (#3b82f6) labeled '核心指令层 <5k词' (Core Instruction Layer <5k words)
- Bottom layer in dark blue (#1e40af) labeled '资源层 无限制' (Resource Layer Unlimited)
On the right side, arrows show progressive loading from top to bottom with text '按需加载' (Load on Demand).
On the left, simple icons represent each layer: lightbulb for metadata, gear for instructions, database for resources.
Style: clean, professional technical diagram, minimal design, data visualization style.
All text in simplified Chinese, minimal and accurate text.
16:9 aspect ratio, high quality."""

    output_path = r"G:\git_pull\微信公众号文章\AI提效系列\claude_skills_architecture.png"

    try:
        print("Generating architecture diagram...")
        generator = GeminiImageGenerator()
        result = generator.generate(prompt, output_path)
        print(f"Success: {result}")
        return 0
    except Exception as e:
        print(f"Error: {str(e)}")
        return 1

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "architecture":
        sys.exit(generate_architecture())
    else:
        sys.exit(generate_cover())
