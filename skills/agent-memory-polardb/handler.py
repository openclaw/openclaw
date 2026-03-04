import os
import logging
from typing import List, Optional, Union
from mem0 import Memory
from mem0 import MemoryClient

def _get_client():
    """
    内部辅助函数：初始化 PolarDB Mem0 客户端。
    Internal helper: Initializes the PolarDB Mem0 client using environment variables.
    """
    # 从 OpenClaw 环境变量中读取配置
    api_key = os.getenv("MEM0_API_KEY")
    org_id = os.getenv("MEM0_ORG_ID")

    # PolarDB Mem0 托管服务专用域名
    # Official endpoint for PolarDB Mem0 managed service
    host = "https://mem0test01.polardb.com"

    if not api_key or not org_id:
        raise ValueError("Error: MEM0_API_KEY or MEM0_ORG_ID is not set in environment.")

    # 初始化客户端，无需配置额外的 Vector Store 或 Graph Store
    # Initializing client without extra vector/graph config as it's built-in
    return MemoryClient(api_key=api_key, org_id=org_id, host=host)

def save_fact(fact: str, user_id: str = "default_user") -> str:
    """
    主动记录事实：将用户信息存入 PolarDB 云端记忆。
    Memorize: Saves user facts/preferences into PolarDB cloud memory.

    :param fact: 要记忆的内容 (The content to remember)
    :param user_id: 用户唯一标识 (Unique user identifier)
    """
    try:
        client = _get_client()
        # PolarDB 会自动进行语义提取、向量化并更新知识图谱
        # PolarDB automatically performs extraction, vectorization, and graph updates
        client.add(fact, user_id=user_id)
        return "Success: Fact has been synchronized to your long-term memory."
    except Exception as e:
        return f"Error saving fact: {str(e)}"

def search_memories(query: str, user_id: str = "default_user") -> str:
    """
    背景检索：根据当前上下文，从 PolarDB 中检索相关记忆。
    Recall: Retrieves relevant context from PolarDB based on the query.

    :param query: 检索关键词或问题 (Search query or natural language question)
    :param user_id: 用户唯一标识 (Unique user identifier)
    """
    try:
        client = _get_client()
        # 执行语义搜索和关系搜索
        # Performs semantic and relational search
        results = client.search(query, user_id=user_id)

        if not results:
            return "No relevant past information found."

        # 格式化输出，方便 Agent 直接阅读
        # Format results for easy consumption by the AI Agent
        formatted_list = [f"• {m['text']}" for m in results]
        return "Relevant history found:\n" + "\n".join(formatted_list)
    except Exception as e:
        return f"Error searching memory: {str(e)}"

def delete_all_memories(confirm: bool, user_id: str = "default_user") -> str:
    """
    危险操作：清空该用户的所有记忆。
    High-Risk: Purges all stored memories for the specific user.
    
    :param confirm: 必须为 True 才会执行 (Must be True to execute)
    """
    if not confirm:
        return "Operation cancelled. Please set 'confirm=True' to purge memory."
    try:
        client = _get_client()
        client.delete_all(user_id=user_id)
        return "Warning: All personal memories for this user have been permanently deleted."
    except Exception as e:
        return f"Error during memory purge: {str(e)}"
