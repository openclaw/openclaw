#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将 <pre><code> 代码块转换为微信兼容的 <div> + <br> + &nbsp; 格式
"""

import re
import sys

def convert_code_blocks(html_content):
    """转换所有代码块为 div + br 格式"""

    def convert_pre_block(match):
        # 提取 pre 标签的样式
        pre_tag = match.group(0)
        pre_styles = re.search(r'<pre\s+style="([^"]+)"', pre_tag)

        # 提取 code 内容
        code_content = match.group(1)

        # 处理内容：
        # 1. 将所有空格替换为 &nbsp;
        # 2. 将所有换行替换为 <br>

        # 逐字符处理，区分标签内和标签外
        result = []
        i = 0
        while i < len(code_content):
            if code_content[i:i+1] == '<':
                # 找到标签结束
                tag_end = code_content.find('>', i)
                if tag_end != -1:
                    result.append(code_content[i:tag_end+1])
                    i = tag_end + 1
                else:
                    result.append(code_content[i])
                    i += 1
            elif code_content[i] == '\n':
                result.append('<br>\n')
                i += 1
            elif code_content[i] == ' ':
                result.append('&nbsp;')
                i += 1
            else:
                result.append(code_content[i])
                i += 1

        converted_content = ''.join(result)

        # 构建新的 div 结构
        if pre_styles:
            style = pre_styles.group(1)
            # 移除 white-space 和 overflow 相关属性，这些对 div 无效
            style = re.sub(r'white-space:\s*[^;]+;?', '', style)
            style = re.sub(r'overflow[^:]*:\s*[^;]+;?', '', style)
            style = style.strip()

            return f'<div style="{style}">{converted_content}</div>'
        else:
            return f'<div>{converted_content}</div>'

    # 转换所有 <pre><code>...</code></pre>
    html_content = re.sub(
        r'<pre[^>]*><code>(.*?)</code></pre>',
        convert_pre_block,
        html_content,
        flags=re.DOTALL
    )

    return html_content

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("用法: python3 convert-to-div-br.py <输入文件> <输出文件>")
        sys.exit(1)

    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        content = f.read()

    converted = convert_code_blocks(content)

    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        f.write(converted)

    print("✓ 已转换为 div + br + &nbsp; 格式")
