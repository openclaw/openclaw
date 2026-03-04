import os
import logging
from mem0 import Memory

# 配置日志输出，便于在 OpenClaw 运行环境中调试
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class PolarDBMem0Handler:
    """
    PolarDB Mem0 记忆管理处理器。
    对接阿里云 PolarDB Mem0 托管长记忆服务，提供高性能向量检索与事实管理 <sub index="1" url="https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-mem0" title="PolarDB 长期记忆Mem0 - 文档" snippet=""></sub>。
    """

    def __init__(self, config=None):
        """
        初始化 PolarDB Mem0 客户端。
        :param config: 配置字典。若为空，则尝试从环境变量读取连接信息。
        """
        # PolarDB Mem0 完全兼容开源 Mem0 SDK 的配置模式 <sub index="1" url="https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-mem0" title="PolarDB 长期记忆Mem0 - 文档" snippet=""></sub>。
        # 默认配置示例，生产环境建议通过环境变量注入敏感信息。
        default_config = {
            "vector_store": {
                "provider": "polardb",  # 使用 PolarDB 作为向量存储后端 <sub index="1" url="https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-mem0" title="PolarDB 长期记忆Mem0 - 文档" snippet=""></sub>
                "config": {
                    "host": os.getenv("POLARDB_HOST", "localhost"),
                    "port": int(os.getenv("POLARDB_PORT", 5432)),
                    "dbname": os.getenv("POLARDB_DBNAME", "postgres"),
                    "user": os.getenv("POLARDB_USER", "user"),
                    "password": os.getenv("POLARDB_PASSWORD", "password"),
                }
            }
        }
        
        self.config = config or default_config
        try:
            # 初始化 SDK 实例
            self.memory = Memory.from_config(self.config)
            logger.info("PolarDB Mem0 客户端初始化成功。")
        except Exception as e:
            logger.error(f"PolarDB Mem0 初始化失败: {str(e)}")
            raise

    def add(self, content, user_id, metadata=None):
        """
        添加记忆：将对话内容或事实存入 PolarDB。
        :param content: 对话列表（List of dicts）或事实字符串。
        :param user_id: 用户的唯一标识符。
        :param metadata: 附加的元数据信息。
        """
        try:
            result = self.memory.add(content, user_id=user_id, metadata=metadata)
            logger.info(f"已成功为用户 {user_id} 添加记忆数据。")
            return result
        except Exception as e:
            logger.error(f"添加记忆失败: {str(e)}")
            return {"status": "error", "message": str(e)}

    def search(self, query, user_id, limit=5):
        """
        搜索记忆：利用语义检索从 PolarDB 中找回相关的长记忆 <sub index="1" url="https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-mem0" title="PolarDB 长期记忆Mem0 - 文档" snippet=""></sub>。
        :param query: 搜索词或当前对话上下文。
        :param user_id: 用户的唯一标识符。
        :param limit: 返回最相关的记忆条数。
        """
        try:
            # PolarDB 提供亚毫秒级的向量检索能力 <sub index="1" url="https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-mem0" title="PolarDB 长期记忆Mem0 - 文档" snippet=""></sub>。
            results = self.memory.search(query, user_id=user_id, limit=limit)
            return results
        except Exception as e:
            logger.error(f"检索记忆失败: {str(e)}")
            return []

    def get_all(self, user_id):
        """
        列出指定用户的所有存储记忆。
        """
        try:
            return self.memory.get_all(user_id=user_id)
        except Exception as e:
            logger.error(f"获取记忆列表失败: {str(e)}")
            return []

    def delete(self, user_id, memory_id=None):
        """
        删除记忆：支持删除特定 ID 或清空用户所有记忆。
        """
        try:
            if memory_id:
                self.memory.delete(memory_id)
                logger.info(f"已删除特定记忆条目: {memory_id}")
            else:
                self.memory.delete_all(user_id=user_id)
                logger.info(f"已清空用户 {user_id} 的所有记忆。")
            return {"status": "success"}
        except Exception as e:
            logger.error(f"删除操作失败: {str(e)}")
            return {"status": "error", "message": str(e)}

# ---------------------------------------------------------
# OpenClaw Skill 核心调用接口示例
# ---------------------------------------------------------
def main(event):
    """
    Skill 统一入口函数。
    :param event: 包含动作类型（action）及参数的事件对象。
    """
    # 实例化处理器（实际开发中可设为全局单例）
    handler = PolarDBMem0Handler()
    
    action = event.get("action")
    user_id = event.get("user_id", "default_user")
    
    if action == "save":
        # 存入新对话或偏好
        return handler.add(event.get("content"), user_id, event.get("metadata"))
    
    elif action == "recall":
        # 根据当前问题检索记忆
        return handler.search(event.get("query"), user_id)
    
    elif action == "clear":
        # 清空记忆
        return handler.delete(user_id)
    
    else:
        return {"status": "error", "message": f"不支持的动作类型: {action}"}
