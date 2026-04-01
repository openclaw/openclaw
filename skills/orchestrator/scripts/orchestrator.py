#!/usr/bin/env python3
"""
Orchestrator Skill - CLI Entry Point

提供两个子命令：
- decompose: 将任务描述分解为结构化子任务
- synthesize: 将收集的结果合并为最终报告

用法：
  python3 orchestrator.py decompose "任务描述" [--config config.yaml] [--output subtasks.json]
  python3 orchestrator.py synthesize --results results.json --conflicts conflicts.json --output report.txt
"""

import argparse
import json
import sys
from pathlib import Path

def cmd_decompose(args):
    """
    分解任务
    实际实现会调用主agent的LLM能力，或使用本地decomposer逻辑
    """
    task = args.task
    output_path = args.output or "subtasks.json"
    
    # TODO: 实现真正的分解逻辑
    # 选项1: 调用主agent的聊天能力（通过gateway API）
    # 选项2: 使用本地规则/简单LLM（如果需要离线）
    
    # 临时模拟输出
    subtasks = [
        {
            "id": "task_1",
            "description": f"处理: {task[:50]}...",
            "type": "code",
            "dependencies": [],
            "priority": 1
        }
    ]
    
    result = {
        "subtasks": subtasks,
        "metadata": {
            "total": len(subtasks),
            "estimatedComplexity": "low"
        }
    }
    
    with open(output_path, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    print(f"✅ 分解完成: {len(subtasks)} 个子任务 → {output_path}")
    return 0

def cmd_synthesize(args):
    """
    合成结果
    """
    results_path = args.results
    conflicts_path = args.conflicts
    output_path = args.output or "report.txt"
    
    try:
        with open(results_path, 'r') as f:
            results = json.load(f)
    except Exception as e:
        print(f"❌ 无法读取结果文件: {e}", file=sys.stderr)
        return 1
    
    conflicts = []
    if conflicts_path and Path(conflicts_path).exists():
        with open(conflicts_path, 'r') as f:
            conflicts = json.load(f)
    
    # 生成报告
    lines = []
    lines.append("=== Orchestration Report ===")
    lines.append("")
    
    completed = [r for r in results if r.get('status') == 'completed']
    failed = [r for r in results if r.get('status') in ('failed', 'timeout')]
    
    lines.append(f"✅ 完成: {len(completed)} 个子任务")
    lines.append(f"❌ 失败: {len(failed)} 个子任务")
    lines.append(f"⚠️  冲突: {len(conflicts)} 个文件")
    lines.append("")
    
    if completed:
        lines.append("--- 已完成任务 ---")
        for r in completed:
            duration = r.get('durationMs', 0) / 1000
            lines.append(f"✓ {r['subtaskId']} ({duration:.1f}s)")
            if 'output' in r and r['output']:
                output_preview = r['output'][:100] + '...' if len(r['output']) > 100 else r['output']
                lines.append(f"  输出: {output_preview}")
        lines.append("")
    
    if failed:
        lines.append("--- 失败任务 ---")
        for r in failed:
            lines.append(f"✗ {r['subtaskId']}: {r.get('error', 'unknown error')}")
        lines.append("")
    
    if conflicts:
        lines.append("--- 冲突文件 ---")
        for c in conflicts:
            lines.append(f"⚠️  {c['file']}")
            lines.append(f"   涉及任务: {', '.join(c['tasks'])}")
        lines.append("")
    
    lines.append("=== End of Report ===")
    
    report = "\n".join(lines)
    
    with open(output_path, 'w') as f:
        f.write(report)
    
    print(report)
    print(f"\n📄 报告已保存: {output_path}")
    return 0

def main():
    parser = argparse.ArgumentParser(
        description="Orchestrator Skill CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 分解任务
  python3 orchestrator.py decompose "重构auth模块并更新测试" --output plan.json
  
  # 合成结果
  python3 orchestrator.py synthesize --results collected.json --conflicts conflicts.json
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='子命令')
    
    # decompose 命令
    p_decompose = subparsers.add_parser('decompose', help='分解任务')
    p_decompose.add_argument('task', help='任务描述')
    p_decompose.add_argument('--config', help='配置文件路径 (未实现)')
    p_decompose.add_argument('--output', '-o', help='输出JSON文件路径 (默认: subtasks.json)')
    p_decompose.set_defaults(func=cmd_decompose)
    
    # synthesize 命令
    p_synthesize = subparsers.add_parser('synthesize', help='合成结果')
    p_synthesize.add_argument('--results', '-r', required=True, help='结果JSON文件路径')
    p_synthesize.add_argument('--conflicts', '-c', help='冲突JSON文件路径')
    p_synthesize.add_argument('--output', '-o', help='输出报告文件路径 (默认: report.txt)')
    p_synthesize.set_defaults(func=cmd_synthesize)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    return args.func(args)

if __name__ == '__main__':
    sys.exit(main())
