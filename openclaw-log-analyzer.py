#!/usr/bin/env python3
"""
OpenClaw 日志分析器 V3 - 完整版

完整提取对话流程，包括：
- ✅ 时间戳（精确到毫秒）
- ✅ 系统 Prompt
- ✅ 用户 Session
- ✅ 用户 Query
- ✅ 大模型思考过程（fullThinking + inline thinking块）
- ✅ 工具调用（从 messages 中完整提取）
- ✅ 工具参数明文
- ✅ 工具执行结果
- ✅ thoughtSignature
- ✅ 大模型回复
- ✅ 任务耗时

按时间戳排序成完整 Action List
"""

import json
import sys
from datetime import datetime
from collections import defaultdict
from typing import Dict, List, Any, Optional


class ActionItem:
    """单个操作项"""
    def __init__(self, timestamp: str, action_type: str, data: Any, seq: int = 0):
        self.timestamp = timestamp
        self.action_type = action_type
        self.data = data
        self.run_id = None
        self.session_id = None
        self.seq = seq  # 同一时间戳的序号
    
    def get_sort_key(self) -> tuple:
        return (self.timestamp or "9999-99-99", self.seq)


class ConversationAnalyzer:
    """对话分析器"""
    def __init__(self, log_file: str):
        self.log_file = log_file
        self.actions: List[ActionItem] = []
        self.action_seq = 0
    
    def parse(self):
        """解析日志文件"""
        print(f"📖 正在解析日志: {self.log_file}\n")
        
        with open(self.log_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                try:
                    log_entry = json.loads(line)
                    self._process_entry(log_entry)
                except json.JSONDecodeError:
                    continue
        
        # 按时间戳和序号排序
        self.actions.sort(key=lambda x: x.get_sort_key())
    
    def _next_seq(self) -> int:
        """获取下一个序号"""
        self.action_seq += 1
        return self.action_seq
    
    def _process_entry(self, entry: Dict):
        """处理单条日志"""
        timestamp = entry.get("time") or entry.get("_meta", {}).get("date")
        message_field = entry.get("2", "")
        data_field = entry.get("1", {})
        
        # 提取 runId 和 sessionId
        run_id = None
        session_id = None
        if isinstance(data_field, dict):
            run_id = data_field.get("runId")
            session_id = data_field.get("sessionId")
        
        # 1. 用户查询
        if "user query:" in message_field or (isinstance(data_field, dict) and "fullPrompt" in data_field):
            action = ActionItem(timestamp, "user_query", {
                "query": data_field.get("fullPrompt") or data_field.get("latestUserPrompt"),
                "run_id": run_id,
                "session_id": session_id
            }, self._next_seq())
            action.run_id = run_id
            action.session_id = session_id
            self.actions.append(action)
        
        # 2. 完整 Prompt 上下文（包含 systemPrompt 和 messages）
        if isinstance(data_field, dict) and "systemPrompt" in data_field:
            # 系统 Prompt - 包含完整 messages 历史
            messages = data_field.get("messages", [])
            action = ActionItem(timestamp, "system_prompt", {
                "prompt": data_field.get("systemPrompt"),
                "provider": data_field.get("provider"),
                "model": data_field.get("model"),
                "think_level": data_field.get("thinkLevel"),
                "reasoning_level": data_field.get("reasoningLevel"),
                "messages": messages,  # 添加完整消息历史
                "latest_user_prompt": data_field.get("latestUserPrompt"),  # 当前用户输入
                "run_id": run_id,
                "session_id": session_id
            }, self._next_seq())
            action.run_id = run_id
            action.session_id = session_id
            self.actions.append(action)
            
            # 解析 messages 数组，提取工具调用和结果
            self._extract_from_messages(messages, timestamp, run_id, session_id)
        
        # 3. 大模型思考过程 - 总结
        if "assistant thinking:" in message_field:
            action = ActionItem(timestamp, "llm_thinking_summary", {
                "thinking": data_field.get("fullThinking"),
                "length": data_field.get("thinkingLength"),
                "run_id": run_id,
                "session_id": session_id
            }, self._next_seq())
            action.run_id = run_id
            action.session_id = session_id
            self.actions.append(action)
        
        # 4. 工具调用汇总
        if isinstance(data_field, dict) and "toolCalls" in data_field:
            for tool_call in data_field.get("toolCalls", []):
                action = ActionItem(timestamp, "tool_call_summary", {
                    "tool_name": tool_call.get("name"),
                    "tool_id": tool_call.get("id"),
                    "arguments": tool_call.get("input"),
                    "run_id": run_id,
                    "session_id": session_id
                }, self._next_seq())
                action.run_id = run_id
                action.session_id = session_id
                self.actions.append(action)
        
        # 5. 工具结果汇总
        if isinstance(data_field, dict) and "toolResults" in data_field:
            for tool_result in data_field.get("toolResults", []):
                action = ActionItem(timestamp, "tool_result_summary", {
                    "tool_id": tool_result.get("toolCallId"),
                    "is_error": tool_result.get("isError", False),
                    "content": tool_result.get("content"),
                    "run_id": run_id,
                    "session_id": session_id
                }, self._next_seq())
                action.run_id = run_id
                action.session_id = session_id
                self.actions.append(action)
        
        # 6. 大模型回复
        if "assistant reply:" in message_field:
            action = ActionItem(timestamp, "assistant_reply", {
                "reply": data_field.get("fullReply"),
                "length": data_field.get("replyLength"),
                "stop_reason": data_field.get("stopReason"),
                "has_tool_calls": data_field.get("hasToolCalls", False),
                "run_id": run_id,
                "session_id": session_id
            }, self._next_seq())
            action.run_id = run_id
            action.session_id = session_id
            self.actions.append(action)
        
        # 7. 任务结束
        if "lane task done" in str(data_field):
            parts = str(data_field).split()
            duration = None
            lane = None
            for part in parts:
                if "durationMs=" in part:
                    duration = part.split("=")[1]
                elif "lane=" in part:
                    lane = part.split("=")[1]
            
            action = ActionItem(timestamp, "task_done", {
                "lane": lane,
                "duration_ms": duration,
                "run_id": run_id,
                "session_id": session_id
            }, self._next_seq())
            action.run_id = run_id
            action.session_id = session_id
            self.actions.append(action)
    
    def _extract_from_messages(self, messages: List[Dict], timestamp: str, run_id: str, session_id: str):
        """从 messages 数组中提取工具调用、思考块和结果"""
        for msg_idx, msg in enumerate(messages):
            role = msg.get("role")
            content = msg.get("content")
            
            if not isinstance(content, list):
                continue
            
            # 遍历 content 块
            for block_idx, block in enumerate(content):
                if not isinstance(block, dict):
                    continue
                
                block_type = block.get("type")
                
                # 思考块
                if block_type == "thinking":
                    action = ActionItem(timestamp, "llm_thinking_inline", {
                        "thinking": block.get("thinking"),
                        "msg_index": msg_idx,
                        "block_index": block_idx,
                        "run_id": run_id,
                        "session_id": session_id
                    }, self._next_seq())
                    action.run_id = run_id
                    action.session_id = session_id
                    self.actions.append(action)
                
                # 工具调用块
                elif block_type == "toolCall":
                    action = ActionItem(timestamp, "tool_call", {
                        "tool_name": block.get("name"),
                        "tool_id": block.get("id"),
                        "arguments": block.get("arguments"),
                        "thought_signature": block.get("thoughtSignature"),
                        "msg_index": msg_idx,
                        "block_index": block_idx,
                        "run_id": run_id,
                        "session_id": session_id
                    }, self._next_seq())
                    action.run_id = run_id
                    action.session_id = session_id
                    self.actions.append(action)
            
            # 工具结果（role 为 toolResult）
            if role == "toolResult":
                for block_idx, block in enumerate(content):
                    if isinstance(block, dict):
                        action = ActionItem(timestamp, "tool_result", {
                            "tool_id": msg.get("tool_use_id") or msg.get("toolCallId"),
                            "content": block,
                            "is_error": block.get("type") == "error" or msg.get("isError", False),
                            "msg_index": msg_idx,
                            "block_index": block_idx,
                            "run_id": run_id,
                            "session_id": session_id
                        }, self._next_seq())
                        action.run_id = run_id
                        action.session_id = session_id
                        self.actions.append(action)
    
    def print_timeline(self):
        """打印时间线"""
        print("=" * 120)
        print("OpenClaw 对话时间线（完整 Action List - 按时间戳排序）")
        print("=" * 120)
        print(f"\n总操作数: {len(self.actions)}\n")
        
        current_run = None
        run_counter = 0
        
        for action in self.actions:
            # 检测新的 run
            if action.run_id and action.run_id != current_run:
                current_run = action.run_id
                run_counter += 1
                print("\n" + "=" * 120)
                print(f"对话轮次 #{run_counter}")
                print(f"Run ID: {current_run}")
                if action.session_id:
                    print(f"Session ID: {action.session_id}")
                print("=" * 120)
            
            self._print_action(action)
        
        print("\n" + "=" * 120)
        print("✅ 分析完成")
        print("=" * 120)
    
    def _print_action(self, action: ActionItem):
        """打印单个操作"""
        time_str = self._format_timestamp(action.timestamp)
        
        if action.action_type == "user_query":
            print(f"\n[{time_str}] 👤 用户查询:")
            query = action.data.get("query", "")
            for line in query.split('\n'):
                print(f"  {line}")
        
        elif action.action_type == "system_prompt":
            print(f"\n[{time_str}] ⚙️  系统 Prompt:")
            print(f"  模型: {action.data.get('provider')}/{action.data.get('model')}")
            print(f"  思考级别: {action.data.get('think_level')}")
            print(f"  推理级别: {action.data.get('reasoning_level')}")
            
            # 完整打印系统 Prompt
            prompt = action.data.get("prompt", "")
            print(f"  系统 Prompt 完整内容:")
            for line in prompt.split('\n'):
                print(f"    {line}")
            
            # 简洁打印消息历史（作为注入到 prompt 的部分）
            messages = action.data.get("messages", [])
            if messages:
                print(f"\n  📜 消息历史（注入到 Prompt，共 {len(messages)} 条）:")
                for i, msg in enumerate(messages, 1):
                    role = msg.get("role", "unknown")
                    content = msg.get("content", "")
                    
                    # 简洁摘要：只显示角色和内容类型
                    content_summary = ""
                    if isinstance(content, list):
                        types = []
                        for block in content:
                            if isinstance(block, dict):
                                block_type = block.get("type", "unknown")
                                types.append(block_type)
                                # 如果是 text，提取前50个字符作为预览
                                if block_type == "text":
                                    text_preview = block.get("text", "")[:50].replace('\n', ' ')
                                    if text_preview:
                                        content_summary = f" - \"{text_preview}...\""
                                        break
                        if not content_summary:
                            content_summary = f" [{', '.join(types)}]"
                    else:
                        content_preview = str(content)[:50].replace('\n', ' ')
                        content_summary = f" - \"{content_preview}...\""
                    
                    print(f"    [{i}] {role}{content_summary}")
            
            # 🔥 重点标记：当前用户输入（latestUserPrompt）
            latest_user_prompt = action.data.get("latest_user_prompt")
            if latest_user_prompt:
                print(f"\n  🔥 当前用户输入（latestUserPrompt）:")
                for line in latest_user_prompt.split('\n'):
                    print(f"    {line}")
        
        elif action.action_type == "llm_thinking_summary":
            print(f"\n[{time_str}] 🧠 大模型思考（总结）:")
            thinking = action.data.get("thinking", "")
            for line in thinking.split('\n'):
                print(f"  {line}")
        
        elif action.action_type == "llm_thinking_inline":
            print(f"\n[{time_str}] 💭 大模型思考（子任务）:")
            thinking = action.data.get("thinking", "")
            for line in thinking.split('\n'):
                print(f"  {line}")
        
        elif action.action_type == "tool_call":
            tool_name = action.data.get("tool_name", "unknown")
            tool_id = action.data.get("tool_id", "")
            args = action.data.get("arguments", {})
            
            # 识别工具类型
            tool_type = self._identify_tool_type(tool_name, args)
            type_label = f" 【{tool_type}】" if tool_type else ""
            
            print(f"\n[{time_str}] 🔧 工具调用{type_label}:")
            print(f"  名称: {tool_name}")
            print(f"  ID: {tool_id}")
            
            # 不显示思考签名（按用户要求省略）
            
            print(f"  参数:")
            if isinstance(args, dict):
                for key, value in args.items():
                    value_str = self._format_value(value, max_len=None)  # 不限制长度
                    # 多行参数缩进显示
                    if '\n' in value_str:
                        print(f"    {key}:")
                        for line in value_str.split('\n'):
                            print(f"      {line}")
                    else:
                        print(f"    {key}: {value_str}")
            else:
                print(f"    {self._format_value(args, max_len=None)}")
        
        elif action.action_type == "tool_call_summary":
            # 这是从 toolCalls 汇总中提取的，可以作为补充
            pass
        
        elif action.action_type == "tool_result":
            tool_id = action.data.get("tool_id", "")
            is_error = action.data.get("is_error", False)
            content = action.data.get("content", "")
            
            status = "❌ 错误" if is_error else "✅ 成功"
            
            print(f"\n[{time_str}] 📦 工具结果 {status}:")
            print(f"  工具 ID: {tool_id}")
            print(f"  结果（完整）:")
            
            # 完整格式化结果，不省略任何内容
            result_str = self._format_result_full(content)
            for line in result_str.split('\n'):
                print(f"    {line}")
        
        elif action.action_type == "tool_result_summary":
            # 汇总信息，可选显示
            pass
        
        elif action.action_type == "assistant_reply":
            print(f"\n[{time_str}] 🤖 大模型回复:")
            reply = action.data.get("reply", "")
            print(f"  长度: {action.data.get('length', len(reply))} 字符")
            print(f"  停止原因: {action.data.get('stop_reason', 'unknown')}")
            print(f"  内容:")
            for line in reply.split('\n'):
                print(f"    {line}")
        
        elif action.action_type == "task_done":
            duration = action.data.get('duration_ms')
            lane = action.data.get('lane', 'unknown')
            
            if duration:
                duration_sec = float(duration) / 1000
                print(f"\n[{time_str}] ⏹️  任务结束:")
                print(f"  Lane: {lane}")
                print(f"  耗时: {duration} ms ({duration_sec:.2f} 秒)")
    
    def _identify_tool_type(self, tool_name: str, args: Any) -> Optional[str]:
        """识别工具类型"""
        # Subagent
        if tool_name == "sessions_spawn":
            return "Subagent"
        
        # Shell/Skill
        if tool_name == "exec":
            if isinstance(args, dict):
                command = args.get("command", "")
                description = args.get("description", "")
                
                # Weather Skill
                if "api.open-meteo.com" in command or "wttr.in" in command or "weather" in description.lower():
                    return "Weather Skill"
                
                # GitHub Skill
                if "gh " in command or "github" in description.lower():
                    return "GitHub Skill"
                
                # Apple Notes Skill
                if "memo " in command:
                    return "Apple Notes Skill"
                
                # Apple Reminders Skill
                if "remindctl " in command:
                    return "Apple Reminders Skill"
                
                # Things Skill
                if "things " in command:
                    return "Things Skill"
                
                # API Call
                if "curl " in command or "wget " in command:
                    return "API Call"
                
                return "Shell Command"
        
        # Web Tools
        elif tool_name == "web_search":
            return "Web Search API"
        elif tool_name == "web_fetch":
            return "Web Fetch API"
        
        # Memory Tools
        elif tool_name == "memory_search":
            return "Memory Search"
        elif tool_name == "memory_get":
            return "Memory Get"
        
        # File Tools
        elif tool_name in ["read", "write", "edit"]:
            return "File Tool"
        
        # Browser
        elif tool_name == "browser":
            return "Browser Tool"
        
        # Session Tools
        elif tool_name in ["sessions_list", "sessions_history", "sessions_send"]:
            return "Session Tool"
        
        return "Tool"
    
    def _format_value(self, value: Any, max_len: int = None) -> str:
        """格式化值（max_len=None 表示不限制长度）"""
        if isinstance(value, (dict, list)):
            json_str = json.dumps(value, indent=2, ensure_ascii=False)
            if max_len and len(json_str) > max_len:
                return json_str[:max_len] + "..."
            return json_str
        
        value_str = str(value)
        if max_len and len(value_str) > max_len:
            return value_str[:max_len] + "..."
        return value_str
    
    def _format_result(self, content: Any) -> str:
        """格式化结果（用于旧版本兼容，已废弃）"""
        return self._format_result_full(content)
    
    def _format_result_full(self, content: Any) -> str:
        """完整格式化结果，不省略任何内容"""
        if isinstance(content, dict):
            # 提取关键字段
            if "type" in content and content["type"] == "text":
                return content.get("text", "")
            
            # 工具错误
            if "error" in content:
                return f"错误: {content.get('error', '')}"
            
            # JSON 格式 - 完整输出
            return json.dumps(content, indent=2, ensure_ascii=False)
        
        elif isinstance(content, list):
            # 如果是块数组，提取文本
            texts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        texts.append(block.get("text", ""))
            
            if texts:
                return "\n".join(texts)
            
            # JSON 格式 - 完整输出
            return json.dumps(content, indent=2, ensure_ascii=False)
        
        return str(content)
    
    def _format_timestamp(self, timestamp: str) -> str:
        """格式化时间戳"""
        if not timestamp:
            return "??:??:??.???"
        
        try:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            return dt.strftime("%H:%M:%S.%f")[:-3]
        except:
            return timestamp
    
    def export_json(self, output_file: str):
        """导出为 JSON"""
        result = {
            "total_actions": len(self.actions),
            "actions": []
        }
        
        for action in self.actions:
            result["actions"].append({
                "timestamp": action.timestamp,
                "type": action.action_type,
                "run_id": action.run_id,
                "session_id": action.session_id,
                "data": action.data
            })
        
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        
        print(f"\n✅ 已导出 JSON 到: {output_file}")
    
    def print_statistics(self):
        """打印统计信息"""
        print("\n" + "=" * 120)
        print("📊 统计信息")
        print("=" * 120)
        
        # 统计各类操作
        type_counts = {}
        for action in self.actions:
            type_counts[action.action_type] = type_counts.get(action.action_type, 0) + 1
        
        print("\n操作类型分布:")
        for action_type, count in sorted(type_counts.items(), key=lambda x: x[1], reverse=True):
            type_display = {
                "user_query": "用户查询",
                "system_prompt": "系统Prompt",
                "llm_thinking_summary": "思考总结",
                "llm_thinking_inline": "思考子任务",
                "tool_call": "工具调用",
                "tool_result": "工具结果",
                "assistant_reply": "模型回复",
                "task_done": "任务结束"
            }.get(action_type, action_type)
            print(f"  {type_display:30} {count:5} 次")
        
        # 统计工具使用
        tool_names = []
        for action in self.actions:
            if action.action_type == "tool_call":
                tool_name = action.data.get("tool_name")
                if tool_name:
                    tool_names.append(tool_name)
        
        if tool_names:
            print("\n工具使用频率:")
            from collections import Counter
            for tool, count in Counter(tool_names).most_common():
                tool_type = self._identify_tool_type(tool, {}) or "Tool"
                print(f"  {tool:20} {tool_type:20} {count:5} 次")
        
        # 统计会话和运行
        sessions = set(action.session_id for action in self.actions if action.session_id)
        runs = set(action.run_id for action in self.actions if action.run_id)
        
        print(f"\n会话统计:")
        print(f"  总会话数: {len(sessions)}")
        print(f"  总运行数: {len(runs)}")
        
        # 计算平均耗时
        durations = []
        for action in self.actions:
            if action.action_type == "task_done":
                duration = action.data.get("duration_ms")
                if duration:
                    try:
                        durations.append(float(duration))
                    except:
                        pass
        
        if durations:
            avg_duration = sum(durations) / len(durations)
            max_duration = max(durations)
            min_duration = min(durations)
            print(f"\n任务耗时:")
            print(f"  平均: {avg_duration:.0f} ms ({avg_duration/1000:.2f} 秒)")
            print(f"  最大: {max_duration:.0f} ms ({max_duration/1000:.2f} 秒)")
            print(f"  最小: {min_duration:.0f} ms ({min_duration/1000:.2f} 秒)")


def main():
    if len(sys.argv) < 2:
        print("用法: python3 openclaw-log-analyzer-v3.py <log_file> [options]")
        print("\n选项:")
        print("  --json <output.json>    导出为 JSON 格式")
        print("  --stats                 显示统计信息")
        print("\n示例:")
        print("  python3 openclaw-log-analyzer-v3.py logs/openclaw-2026-02-11.log")
        print("  python3 openclaw-log-analyzer-v3.py logs/openclaw-2026-02-11.log --stats")
        print("  python3 openclaw-log-analyzer-v3.py logs/openclaw-2026-02-11.log --json analysis.json --stats")
        sys.exit(1)
    
    log_file = sys.argv[1]
    
    # 检查文件
    try:
        with open(log_file, 'r') as f:
            pass
    except FileNotFoundError:
        print(f"❌ 错误: 找不到日志文件 {log_file}")
        sys.exit(1)
    
    # 解析日志
    analyzer = ConversationAnalyzer(log_file)
    analyzer.parse()
    
    # 打印时间线
    analyzer.print_timeline()
    
    # 统计信息
    if "--stats" in sys.argv:
        analyzer.print_statistics()
    
    # 导出 JSON
    if "--json" in sys.argv:
        json_index = sys.argv.index("--json")
        if json_index + 1 < len(sys.argv):
            output_file = sys.argv[json_index + 1]
            analyzer.export_json(output_file)


if __name__ == "__main__":
    main()
