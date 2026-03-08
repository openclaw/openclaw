#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修复微信公众号显示问题
1. 彻底去除首行缩进
2. 减小段落间距
3. 压缩HTML去除多余空白
"""

import sys
import re

def fix_wechat_style(html_content):
    """修复微信公众号样式问题

    解决的问题：
    1. 编辑模式下莫名空行（HTML换行符被渲染）
    2. 样式错位（text-indent、margin被重置）
    3. 布局打乱（vertical-align失效）
    4. 代码块格式保留（使用<br>替换换行）
    """

    # === 代码块特殊处理：完全保留原始格式，使用占位符 ===
    code_blocks = []
    def save_code_block(match):
        """保存代码块原样，用占位符替换"""
        code_blocks.append(match.group(0))
        return f'___CODE_BLOCK_{len(code_blocks)-1}___'

    # 先提取所有代码块（保持原样）
    html_content = re.sub(
        r'<pre[^>]*>.*?</pre>',
        save_code_block,
        html_content,
        flags=re.DOTALL
    )

    # === 核心修复：删除标签间的所有空白和换行符 ===
    # 这是导致空行问题的根本原因（但跳过已处理的代码块）
    html_content = re.sub(r'>\s+<', '><', html_content)

    # 保留注释后的换行（便于阅读）
    html_content = re.sub(r'(<!--[^>]+-->)<', r'\1\n<', html_content)

    # === 样式修复：确保关键样式不被微信编辑器破坏 ===

    # 1. text-indent 强制为 0 且使用 !important
    html_content = re.sub(r'text-indent:\s*[^;!]+;', 'text-indent: 0 !important;', html_content)
    html_content = re.sub(r'text-indent:\s*0;', 'text-indent: 0 !important;', html_content)

    # 2. 添加 !important 到关键对齐属性
    # vertical-align（防止圆形序号错位）
    html_content = re.sub(
        r'vertical-align:\s*([^;]+);',
        r'vertical-align: \1 !important;',
        html_content
    )

    # text-align（防止对齐错位）
    html_content = re.sub(
        r'text-align:\s*([^;!]+);',
        r'text-align: \1 !important;',
        html_content
    )

    # 3. margin 值优化（减小不必要的间距）
    # 段落 margin 统一为最小值
    html_content = re.sub(r'margin:\s*\d+px\s+0;', 'margin: 0 0 8px 0;', html_content)
    html_content = re.sub(r'margin:\s*0;', 'margin: 0 0 8px 0;', html_content)

    # section 之间保留适当间距
    html_content = re.sub(r'margin-bottom:\s*\d+px;', 'margin-bottom: 12px;', html_content)

    # 4. display 属性加 !important（防止布局打乱）
    html_content = re.sub(
        r'display:\s*inline-block;',
        'display: inline-block !important;',
        html_content
    )

    # 5. 确保所有 margin:0 的地方真正生效
    html_content = re.sub(
        r'margin:\s*0\s+0\s+\d+px\s+0;',
        lambda m: m.group(0).replace(';', ' !important;'),
        html_content
    )

    # === 恢复代码块（保持原始格式） ===
    for i, code_block in enumerate(code_blocks):
        html_content = html_content.replace(f'___CODE_BLOCK_{i}___', code_block)

    return html_content

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("用法: python3 fix-wechat-style.py <输入文件> <输出文件>")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    print(f"→ 读取文件: {input_file}")
    with open(input_file, 'r', encoding='utf-8') as f:
        html_content = f.read()

    print("→ 修复样式...")
    fixed_content = fix_wechat_style(html_content)

    print(f"→ 保存到: {output_file}")
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(fixed_content)

    print("✓ 修复完成！")
    print("\n修复内容：")
    print("  - 首行缩进: 强制设置为0 !important")
    print("  - 段落间距: 统一为6px")
    print("  - 删除所有多余空白")
