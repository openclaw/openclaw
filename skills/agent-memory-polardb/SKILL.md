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

# Tools
## save_fact
Saves a specific fact, user preference, or context into the PolarDB persistent memory.
- **fact** (string, required): The core information to be remembered. Use clear, descriptive statements (e.g., "User prefers dark mode for all UI components" or "User is a senior Python developer").
- **metadata** (object, optional): Additional key-value pairs for filtering or categorization (e.g., {"category": "coding_pref"}).
  
## search_memories
Retrieves relevant historical context or user facts from PolarDB based on a semantic query.
- **query** (string, required): The natural language description or keyword of what you are trying to recall (e.g., "What are the user's career goals?" or "Previous feedback on project architecture").
- **limit** (integer, optional): The maximum number of memory fragments to return. Defaults to 5.

## delete_all_memories
[High-Risk] Permanently erases all long-term memories for the current user from PolarDB.
- **confirm** (boolean, required): Must be set to `true` to execute. Only use this when the user explicitly requests to "forget everything" or "reset all memories."

# Configuration
To enable the PolarDB-powered memory system, follow these steps:
1. **Access the Console**: Visit the [Alibaba Cloud PolarDB Console](https://polardb.console.aliyun.com/cn-hangzhou/mem0).
2. **Activate Mem0**: Enable the Mem0 service within your PolarDB instance and retrieve your unique `MEM0_API_KEY` and `MEM0_ORG_ID`.
3. **Endpoint Details**:
   - **Service Host**: `mem0test01.polardb.com` (Ensure your network allows outbound traffic to this host).
4. **Set Environment Variables**:
   - `/env set MEM0_API_KEY=your_key`
   - `/env set MEM0_ORG_ID=your_id`

# Output Format
1. **Natural Integration**: Do not explicitly mention "searching memory." Incorporate retrieved facts naturally into the conversation (e.g., "Since you're learning Rust, you might like...").
2. **Contextual Awareness**: Use retrieved facts to personalize recommendations and technical advice.
3. **Graceful Handling**: If no relevant memory is found, provide a high-quality response without mentioning the search failure.
4. **Action Feedback**: Briefly confirm after successful `save_fact` calls to build user trust (e.g., "Noted your preference for PolarDB.").

# Examples
### Scenario 1: Memory Add (Ingestion)
- **User**: "I’m starting to prepare for the AWS Solutions Architect exam next month, and I'm feeling a bit overwhelmed."
- **Agent Action**: Call `save_fact(fact="User is planning to take the AWS Certified Solutions Architect exam next month.")`
- **Logic**: Converts casual conversation into a structured fact with a specific goal and timeline.

### Scenario 2: Retrieval (Context Recall)
- **User**: "Can you help me create a study roadmap?"
- **Agent Action**: Call `search_memories(query="User's professional goals and upcoming certification plans")`
- **Logic**: Proactively searches PolarDB to retrieve the "AWS Exam" context before generating a personalized response.

### Scenario 3: Update & Conflict Resolution
- **User**: "I’ve decided to drop the AWS exam. I think Alibaba Cloud's PolarDB has more potential for my career, so I’m going for the ACP certification instead."
- **Agent Action**: Call `save_fact(fact="User cancelled AWS exam plans and is now focusing on Alibaba Cloud ACP certification.")`
- **Logic**: PolarDB Mem0 automatically resolves the conflict. In future interactions, the Agent will prioritize the new ACP goal over the outdated AWS info.

### Scenario 4: Consolidation (Information Synthesis)
- **User (Monday)**: "I'm self-studying vector databases today."
- **User (Wednesday)**: "I'm currently reading about PolarDB's vector index implementation."
- **Agent Action**: Call `save_fact(fact="User is deeply researching vector database technologies, with a specific focus on PolarDB vector indexing.")`
- **Logic**: Instead of storing two fragmented notes, the system merges related information into a comprehensive user profile.

### Scenario 5: Decay & Temporal Relevance
- **User**: "Should I continue with that project I mentioned before?"
- **Agent Action**: Call `search_memories(query="Status of user's past ongoing projects")`
- **Logic**: PolarDB calculates relevance based on timestamps. If a project was mentioned years ago and never touched again, its weight decays. The Agent can then respond intelligently: "Are you referring to the old Project X from 2023, or the Project Y we discussed last week?"

# Security & Privacy
- **Data Isolation**: Memories are strictly isolated by `MEM0_ORG_ID` and `user_id`. No cross-user data leakage is possible.
- **Encryption**: All data transmitted to `mem0.polar-db.com` is encrypted via TLS 1.3.
- **Compliance**: Powered by Alibaba Cloud PolarDB, adhering to global data protection standards.

# Tags
`Memory-as-a-Service` `Long-term-Context` `PolarDB` `Vector-Database` `Mem0` `Enterprise-AI`
