#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按照优化后的设计原则生成封面图"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from generate_image import GeminiImageGenerator

def generate_optimized_cover():
    """
    按照新的设计原则生成Claude Skills封面图

    设计原则：
    1. 鲜明的主题色彩 - 蓝紫渐变 (科技创新类)
    2. 清晰的视觉层次 - 主标题 + 副标题 + 视觉元素
    3. 现代化设计风格 - 3D元素、玻璃拟态、渐变光效
    4. 情感共鸣 - "告别重复劳动"、"秒变专家"
    """

    # 步骤1: 主题分析
    # 关键词: Claude Skills, AI提效, 技能包, 专家系统
    # 核心价值: 让AI秒变领域专家
    # 目标情绪: 好奇、兴奋、启发

    # 步骤2: 配色方案
    # 科技创新类: 蓝紫渐变 (#1a1f5c → #7c3aed)

    # 步骤3: 构建提示词（使用AI/大模型类模板）
    prompt = """A stunning, eye-catching cover image for Claude Skills article.

Design specifications:
- Background: vibrant gradient from deep blue (#1a1f5c) to electric purple (#7c3aed), with subtle particle effects and glowing accents
- Center focal point: futuristic 3D floating cubes/modules in glass morphism style, representing different skills
- Each cube has a glowing icon inside: document (文档), code brackets (代码), chart (数据)
- Cubes are connected by luminous blue energy lines, creating a network effect
- Depth and dimension: strong 3D perspective with light reflections

Text layout (CRITICAL - all text in simplified Chinese):
- Top center: Large bold title "Claude Skills" in white, modern sans-serif font
- Below title: Chinese subtitle "让AI秒变领域专家" in elegant, clean font
- Bottom left corner: Small text "告别重复劳动 | 10倍提效" as a tagline

Visual effects:
- Glowing particles floating in the background
- Soft light rays emanating from the cubes
- Professional depth of field (bokeh effect)
- Clean, uncluttered composition with proper whitespace

Style: ultra-modern, tech-forward, professional, highly attractive, sci-fi inspired
Mood: innovative, powerful, exciting, transformative
Color harmony: blue-purple gradient with cyan and white accents

IMPORTANT: All text in simplified Chinese (简体中文), minimal text, accurate and clear.
Aspect ratio: 16:9, high quality, magazine cover style.
"""

    output_path = r"G:\git_pull\微信公众号文章\AI提效系列\claude_skills_cover_optimized.png"

    try:
        print("Generating optimized cover image with enhanced design principles...")
        print("Theme: Claude Skills - AI Capability Extension System")
        print("Core value: Turn AI into domain experts instantly")
        print("Color scheme: Blue-purple gradient (tech innovation)")
        print("Emotional appeal: Curiosity, excitement, empowerment")
        print("")

        generator = GeminiImageGenerator()
        result = generator.generate(prompt, output_path)

        print(f"Success: {result}")
        print("")
        print("Quality checklist:")
        print("- Clear and readable Chinese text")
        print("- Eye-catching colors")
        print("- Strong visual hierarchy")
        print("- Aligned with theme")

        return 0
    except Exception as e:
        print(f"Error: {str(e)}")
        return 1

if __name__ == "__main__":
    sys.exit(generate_optimized_cover())
