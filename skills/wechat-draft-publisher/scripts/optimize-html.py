#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
优化HTML文章的段落间距，适配微信公众号
"""

import sys
import re

def optimize_html_spacing(html_content):
    """优化HTML的段落间距和首行缩进"""

    # 段落间距优化（支持多种原始值）
    html_content = html_content.replace('margin: 18px 0', 'margin: 4px 0')
    html_content = html_content.replace('margin: 15px 0', 'margin: 4px 0')  # 蓝色科技风
    html_content = html_content.replace('margin: 20px 0', 'margin: 4px 0')
    html_content = html_content.replace('margin: 8px 0', 'margin: 4px 0')
    html_content = html_content.replace('margin: 15px 0 0 0', 'margin: 4px 0 0 0')

    # 大间距优化（标题等）
    html_content = html_content.replace('margin: 40px 0', 'margin: 12px 0')  # 蓝色科技风大间距
    html_content = html_content.replace('margin: 28px 0 20px 0', 'margin: 12px 0 6px 0')
    html_content = html_content.replace('margin: 32px 0 24px 0', 'margin: 14px 0 8px 0')
    html_content = html_content.replace('margin: 20px 0 12px 0', 'margin: 12px 0 6px 0')
    html_content = html_content.replace('margin: 24px 0 16px 0', 'margin: 14px 0 8px 0')

    # 图片间距优化
    html_content = html_content.replace('margin: 24px auto', 'margin: 8px auto')
    html_content = html_content.replace('margin: 12px auto', 'margin: 6px auto')

    # 首行缩进设置为2em（2个字符）
    html_content = html_content.replace('text-indent: 0;', 'text-indent: 2em;')

    # 删除段落之间的多余换行（压缩HTML）
    html_content = re.sub(r'</p>\s+<p', '</p><p', html_content)
    html_content = re.sub(r'</section>\s+<section', '</section><section', html_content)

    return html_content

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("用法: python3 optimize-html.py <输入文件> <输出文件>")
        print("示例: python3 optimize-html.py article.html article-optimized.html")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    print(f"→ 读取文件: {input_file}")
    with open(input_file, 'r', encoding='utf-8') as f:
        html_content = f.read()

    print("→ 优化段落间距...")
    optimized_content = optimize_html_spacing(html_content)

    print(f"→ 保存到: {output_file}")
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(optimized_content)

    print("✓ 优化完成！")
    print("\n调整内容：")
    print("  - 段落间距: 18px → 8px")
    print("  - 标题间距: 减小20-30%")
    print("  - 图片间距: 24px → 12px")
