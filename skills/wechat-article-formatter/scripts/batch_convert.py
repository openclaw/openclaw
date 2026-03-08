#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Batch Markdown to HTML Converter
批量转换Markdown文件为微信公众号HTML
"""

import argparse
import sys
from pathlib import Path
from typing import List
from concurrent.futures import ThreadPoolExecutor, as_completed
from markdown_to_html import WeChatHTMLConverter
import time


class BatchConverter:
    """批量转换器"""

    def __init__(self, theme: str = 'tech', output_dir: str = None, workers: int = 4):
        self.theme = theme
        self.output_dir = Path(output_dir) if output_dir else None
        self.workers = workers
        self.converter = WeChatHTMLConverter(theme=theme)

        # 统计信息
        self.total_files = 0
        self.success_count = 0
        self.failed_count = 0
        self.failed_files = []

    def find_markdown_files(self, input_path: str, recursive: bool = False) -> List[Path]:
        """查找Markdown文件"""
        path = Path(input_path)

        if path.is_file():
            if path.suffix.lower() in ['.md', '.markdown']:
                return [path]
            else:
                print(f'⚠️  警告: {path} 不是Markdown文件，已跳过')
                return []

        elif path.is_dir():
            pattern = '**/*.md' if recursive else '*.md'
            markdown_files = list(path.glob(pattern))

            # 也查找.markdown扩展名
            markdown_pattern = '**/*.markdown' if recursive else '*.markdown'
            markdown_files.extend(path.glob(markdown_pattern))

            return sorted(set(markdown_files))

        else:
            raise FileNotFoundError(f'路径不存在: {input_path}')

    def convert_single_file(self, input_file: Path) -> tuple:
        """转换单个文件"""
        try:
            # 确定输出文件路径
            if self.output_dir:
                output_file = self.output_dir / f'{input_file.stem}.html'
            else:
                output_file = input_file.with_suffix('.html')

            # 转换
            start_time = time.time()
            output_path = self.converter.convert_file(str(input_file), str(output_file))
            elapsed = time.time() - start_time

            return True, input_file, output_path, elapsed

        except Exception as e:
            return False, input_file, str(e), 0

    def convert_batch(self, input_files: List[Path], show_progress: bool = True) -> None:
        """批量转换文件"""
        self.total_files = len(input_files)

        if self.total_files == 0:
            print('⚠️  未找到Markdown文件')
            return

        print(f'📚 找到 {self.total_files} 个Markdown文件')
        print(f'🎨 使用主题: {self.theme}')
        print(f'⚙️  并发数: {self.workers}')
        print()

        # 确保输出目录存在
        if self.output_dir:
            self.output_dir.mkdir(parents=True, exist_ok=True)
            print(f'📁 输出目录: {self.output_dir}')
        else:
            print(f'📁 输出目录: 与源文件相同')

        print()
        print('🚀 开始转换...')
        print('─' * 60)

        # 使用线程池并发转换
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            # 提交所有任务
            future_to_file = {
                executor.submit(self.convert_single_file, file): file
                for file in input_files
            }

            # 处理完成的任务
            for future in as_completed(future_to_file):
                success, input_file, result, elapsed = future.result()

                if success:
                    self.success_count += 1
                    status = '✅'
                    output_path = result
                    message = f'{input_file.name} → {Path(output_path).name} ({elapsed:.2f}s)'
                else:
                    self.failed_count += 1
                    self.failed_files.append((input_file, result))
                    status = '❌'
                    message = f'{input_file.name} - 失败: {result}'

                if show_progress:
                    progress = f'[{self.success_count + self.failed_count}/{self.total_files}]'
                    print(f'{status} {progress} {message}')

        print('─' * 60)
        print()

    def print_summary(self) -> None:
        """打印转换摘要"""
        print('📊 转换摘要')
        print('─' * 60)
        print(f'总文件数: {self.total_files}')
        print(f'✅ 成功: {self.success_count}')
        print(f'❌ 失败: {self.failed_count}')

        if self.failed_files:
            print()
            print('失败文件列表:')
            for file, error in self.failed_files:
                print(f'  • {file.name}: {error}')

        print('─' * 60)

        # 计算成功率
        if self.total_files > 0:
            success_rate = (self.success_count / self.total_files) * 100
            print(f'✨ 成功率: {success_rate:.1f}%')


def main():
    """命令行入口"""
    parser = argparse.ArgumentParser(
        description='批量转换Markdown文件为微信公众号HTML',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例用法:
  # 转换单个文件
  python batch_convert.py --input article.md

  # 转换目录下的所有Markdown文件
  python batch_convert.py --input articles/

  # 递归转换目录及子目录下的所有Markdown文件
  python batch_convert.py --input articles/ --recursive

  # 指定输出目录
  python batch_convert.py --input articles/ --output output/ --theme minimal

  # 使用8个并发线程加快转换速度
  python batch_convert.py --input articles/ --workers 8

转换规则:
  - 默认情况下，HTML文件与Markdown文件在同一目录
  - 使用--output指定统一的输出目录
  - 支持.md和.markdown扩展名
  - 并发转换提高效率（默认4个线程）
        '''
    )

    parser.add_argument('-i', '--input', required=True,
                        help='输入的Markdown文件或目录路径')
    parser.add_argument('-o', '--output',
                        help='输出目录（默认：与源文件相同目录）')
    parser.add_argument('-t', '--theme', default='tech',
                        choices=['tech', 'minimal', 'business'],
                        help='选择主题样式（默认：tech）')
    parser.add_argument('-r', '--recursive', action='store_true',
                        help='递归查找子目录中的Markdown文件')
    parser.add_argument('-w', '--workers', type=int, default=4,
                        help='并发转换的线程数（默认：4）')
    parser.add_argument('-q', '--quiet', action='store_true',
                        help='静默模式，只显示摘要')

    args = parser.parse_args()

    try:
        # 创建批量转换器
        converter = BatchConverter(
            theme=args.theme,
            output_dir=args.output,
            workers=args.workers
        )

        # 查找Markdown文件
        markdown_files = converter.find_markdown_files(args.input, args.recursive)

        if not markdown_files:
            print('❌ 未找到Markdown文件')
            sys.exit(1)

        # 执行批量转换
        converter.convert_batch(markdown_files, show_progress=not args.quiet)

        # 打印摘要
        converter.print_summary()

        # 退出码
        sys.exit(0 if converter.failed_count == 0 else 1)

    except Exception as e:
        print(f'❌ 批量转换失败: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
