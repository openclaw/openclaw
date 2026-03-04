---
name: Agent Memory Management (by PolarDB)
id: polardb-mem0
description: 基于阿里云 PolarDB 的托管级长记忆服务。通过 Mem0 协议实现毫秒级的事实提取、自动更新与跨设备同步。支持自动事实提取、语义去重及毫秒级云端检索。
author: PolarDB Team
version: 1.0.0
metadata:
  openclaw:
    category: intelligence
    emoji: "易"
    tags: ["memory", "vector-db", "polardb", "mem0"]
    requires:
      env:
        - MEM0_API_KEY  # 从阿里云 PolarDB 控制台获取的 API Key
        - MEM0_ORG_ID   # 你的组织 ID
---

# Instructions
你现在拥有一个由 **PolarDB** 驱动的“外挂大脑”，本技能集成了 **PolarDB Mem0** 服务，为 OpenClaw Agent 提供生产级的长期记忆管理方案。它通过替换原生粗粒度的 Markdown 文件存储，实现对用户偏好、事实记忆及事件关系的精准提取与毫秒级检索，支持跨会话（Cross-session）的知识持久化。请遵循以下原则操作记忆：
1. **主动记录 (Memorize)**：
   - 当用户提到核心事实（如“我有两个孩子”、“我正在学习 Rust”）时，必须调用 `save_fact`。
   - 当用户表达明确偏好（如“我不喜欢深色模式”、“周一上午我通常没空”）时，调用 `save_fact`。
2. **背景检索 (Recall)**：
   - 在开启新任务、处理复杂请求或用户问及“我之前说过什么”时，调用 `search_memories`。
   - 检索到的内容应作为你回答的背景信息，确保回答的连贯性。
3. **动态更新**：
   - 如果用户纠正了之前的信息（如“我搬家到上海了”），直接调用 `save_fact`，PolarDB mem0 会根据语义自动合并或更新旧记忆。
