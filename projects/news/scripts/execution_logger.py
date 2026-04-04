"""
執行日誌記錄器
記錄 workflow 每個節點的執行狀態和結果
"""

import json
import logging
from datetime import datetime
from typing import Dict, Any, List
from pathlib import Path

logger = logging.getLogger(__name__)


class ExecutionLogger:
    """執行日誌記錄器"""

    def __init__(self):
        self.execution_data = {
            "execution_id": datetime.now().strftime("%Y%m%d_%H%M%S"),
            "start_time": datetime.now().isoformat(),
            "end_time": None,
            "status": "running",
            "nodes": []
        }

    def log_node_start(self, node_name: str, node_type: str, description: str = ""):
        """記錄節點開始執行"""
        node_data = {
            "name": node_name,
            "type": node_type,
            "description": description,
            "status": "running",
            "start_time": datetime.now().isoformat(),
            "end_time": None,
            "duration": None,
            "input": None,
            "output": None,
            "error": None,
            "metrics": {}
        }
        self.execution_data["nodes"].append(node_data)
        logger.info(f"🔄 [{node_name}] 開始執行...")

    def log_node_input(self, node_name: str, input_data: Any):
        """記錄節點輸入"""
        node = self._find_node(node_name)
        if node:
            # 限制輸入大小以避免 JSON 過大
            if isinstance(input_data, (dict, list)):
                node["input"] = self._truncate_data(input_data, max_items=5)
            else:
                node["input"] = str(input_data)[:500]

    def log_node_success(self, node_name: str, output_data: Any = None, metrics: Dict = None):
        """記錄節點成功完成"""
        node = self._find_node(node_name)
        if node:
            node["status"] = "success"
            node["end_time"] = datetime.now().isoformat()
            node["duration"] = self._calculate_duration(node["start_time"], node["end_time"])

            # 記錄輸出 - 對 AI 節點保留完整文本輸出
            if output_data:
                if isinstance(output_data, (dict, list)):
                    # 對 dict/list 數據，只截斷列表元素，但保留完整文本字段
                    node["output"] = self._smart_truncate(output_data, node["type"])
                else:
                    # 對純文本輸出，AI 節點保留完整內容
                    if node["type"] == "ai":
                        node["output"] = str(output_data)
                    else:
                        node["output"] = str(output_data)[:500]

            # 記錄指標
            if metrics:
                node["metrics"] = metrics

            logger.info(f"✅ [{node_name}] 執行成功")

    def log_node_error(self, node_name: str, error: Exception):
        """記錄節點執行錯誤"""
        node = self._find_node(node_name)
        if node:
            node["status"] = "error"
            node["end_time"] = datetime.now().isoformat()
            node["duration"] = self._calculate_duration(node["start_time"], node["end_time"])
            node["error"] = {
                "type": type(error).__name__,
                "message": str(error)[:500]
            }
            logger.error(f"❌ [{node_name}] 執行失敗: {str(error)}")

    def complete_execution(self, status: str = "success"):
        """完成整個執行"""
        self.execution_data["end_time"] = datetime.now().isoformat()
        self.execution_data["status"] = status
        logger.info(f"🏁 執行完成，狀態: {status}")

    def save_to_file(self, filepath: str = "execution_log.json"):
        """保存執行日誌到文件"""
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(self.execution_data, f, ensure_ascii=False, indent=2)
            logger.info(f"💾 執行日誌已保存: {filepath}")
        except Exception as e:
            logger.error(f"保存執行日誌失敗: {str(e)}")

    def _find_node(self, node_name: str) -> Dict:
        """查找節點"""
        for node in reversed(self.execution_data["nodes"]):
            if node["name"] == node_name:
                return node
        return None

    def _calculate_duration(self, start_time: str, end_time: str) -> float:
        """計算執行時間（秒）"""
        try:
            start = datetime.fromisoformat(start_time)
            end = datetime.fromisoformat(end_time)
            return (end - start).total_seconds()
        except:
            return 0

    def _truncate_data(self, data: Any, max_items: int = 5) -> Any:
        """截斷數據以避免過大"""
        if isinstance(data, list):
            if len(data) > max_items:
                return data[:max_items] + [f"... 還有 {len(data) - max_items} 項"]
            return data
        elif isinstance(data, dict):
            if len(data) > max_items:
                items = list(data.items())[:max_items]
                result = dict(items)
                result["..."] = f"還有 {len(data) - max_items} 個鍵"
                return result
            return data
        return data

    def _smart_truncate(self, data: Any, node_type: str) -> Any:
        """智能截斷數據 - AI 節點保留完整文本輸出"""
        if isinstance(data, dict):
            result = {}
            for key, value in data.items():
                # AI 節點的文本輸出字段保留完整內容
                if node_type == "ai" and isinstance(value, str) and any(
                    keyword in key.lower()
                    for keyword in ["text", "report", "message", "content", "output"]
                ):
                    result[key] = value  # 保留完整文本
                elif isinstance(value, list) and len(value) > 5:
                    result[key] = value[:5] + [f"... 還有 {len(value) - 5} 項"]
                elif isinstance(value, str) and len(value) > 1000 and node_type != "ai":
                    result[key] = value[:1000] + "..."
                else:
                    result[key] = value
            return result
        elif isinstance(data, list):
            if len(data) > 5:
                return data[:5] + [f"... 還有 {len(data) - 5} 項"]
            return data
        return data
