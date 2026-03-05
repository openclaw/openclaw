---
name: Agent Memory Management (by PolarDB)
id: agent-memory-polardb
description: A managed long-term memory service powered by Alibaba Cloud PolarDB. It leverages the Mem0 protocol to enable millisecond-level fact extraction, automatic updates, and cross-device synchronization. Features include automated fact extraction, semantic deduplication, and sub-millisecond cloud-based retrieval.
author: PolarDB Team
version: 1.0.0
metadata:
  openclaw:
    category: intelligence
    emoji: "易"
    tags: ["memory", "vector-db", "polardb", "mem0"]
    requires:
      - MEM0_HOST   # The endpoint URL (e.g., http://118.136.94.73:8080) obtained from the Alibaba Cloud PolarDB Console.
      - MEM0_API_KEY  # API Key obtained from the Alibaba Cloud PolarDB Console.
---

# Instructions
You are now equipped with a 'Cloud-Native External Brain' powered by PolarDB. This skill integrates the PolarDB Mem0 service to provide a production-grade long-term memory management solution for OpenClaw Agents. By replacing native, coarse-grained Markdown file storage, it enables precise extraction and millisecond-level retrieval of user preferences, factual memories, and event relationships, supporting cross-session knowledge persistence. Please adhere to the following principles when managing memories:
1. Proactive Memorization (Memorize):
   - When the user mentions core facts (e.g., "I have two children," "I am learning Rust"), you must call save_fact.
   - When the user expresses explicit preferences (e.g., "I don't like dark mode," "I am usually unavailable on Monday mornings"), call save_fact.
2. Contextual Retrieval (Recall):
   - When starting new tasks, processing complex requests, or when the user asks, "What did I say before?", call search_memories.
   - The retrieved content should serve as the background for your responses to ensure conversational coherence.
3. Dynamic Update:
   - If the user corrects previous information (e.g., "I've moved to Shanghai"), call save_fact directly. PolarDB mem0 will automatically merge or update the old memory based on semantic context.

# Tools
## Memory Management (PolarDB-Mem0)
This toolset provides long-term memory capabilities based on PolarDB, enabling the Agent to persist, retrieve, and manage user information across different sessions

### 1. save_fact
- **Description**: Persistently stores important facts or user information into the vector database.
- **Parameters**: 
  - `user_id` (string): Unique identifier for the user to ensure data isolation.
  - `fact` (string): The specific fact or statement to remember (e.g., user preferences, habits, or key schedules).
- **Returns**: A JSON object containing the operation status or the ID of the newly stored record.
  
### 2. search_memories
- **Description**: Retrieves relevant memories for a specific user based on semantic similarity.
- **Parameters**:
  - `user_id` (string): The target user ID whose memories are being searched.
  - `query` (string): The search keyword or descriptive question (supports semantic matching).
- **Returns**: A JSON object containing a `results` list, ranked by relevance.

### 3. delete_all_memories
- **Description**: Permanently clears all historical memory records for a specific user (irreversible).
- **Parameters**:
  - `user_id` (string): The unique identifier of the target user.
- **Returns**: A confirmation message of the operation.

# Configuration
To enable the PolarDB-powered memory system, follow these steps:
1. **Access the Console**: Visit the [Alibaba Cloud PolarDB Console](https://polardb.console.aliyun.com/cn-hangzhou/mem0).
2. **Activate Mem0**: Enable the Mem0 service within your PolarDB instance and retrieve your unique `MEM0_API_KEY` and `MEM0_HOST`.
3. **Endpoint Details**:
   - - **Service Host**: The connection is managed via `handler.py`. Ensure the host (IP or Domain) is correctly configured.
4. **Set Environment Variables**:
   - `/env set MEM0_API_KEY=your_key`
   - `/env set MEM0_HOST=PolarDB_mem0_host`

# Output Format
1. **Natural Integration**: Do not explicitly mention "searching memory." Incorporate retrieved facts naturally into the conversation (e.g., "Since you're learning Rust, you might like...").
2. **Contextual Awareness**: Use retrieved facts to personalize recommendations and technical advice.
3. **Graceful Handling**: If no relevant memory is found, provide a high-quality response without mentioning the search failure.
4. **Action Feedback**: Briefly confirm after successful `save_fact` calls to build user trust (e.g., "Noted your preference for PolarDB.").

# Examples
### Scenario 1: Memory Add (Ingestion)
**User Input**: "I am planning to migrate our database to PolarDB next month."
**Agent Action**: Extract the key fact and store it for the specific user.
- **Tool**: save_fact
- **Arguments**: 
    - user_id: "dev_user_01"
    - fact: "The user is planning a database migration to PolarDB next month."

### Scenario 2: Retrieval (Context Recall)
**User Input**: "What was my plan for the database?"
**Agent Action**: Retrieve historical context before answering the question.
- **Tool**: search_memories
- **Arguments**: 
    - user_id: "dev_user_01"
    - query: "database migration plans"

### Scenario 3: Update & Conflict Resolution
**User Input**: "Actually, we decided to migrate in two months, not next month."
**Agent Action**: Update the memory to resolve the conflict between the new input and old data.
- **Tool**: save_fact
- **Arguments**: 
    - user_id: "dev_user_01"
    - fact: "The database migration is now scheduled for two months from now (correction of previous next-month plan)."

### Scenario 4: Consolidation (Information Synthesis)
**User Input**: "We also need to ensure high-availability is enabled."
**Agent Action**: Combine new requirements with the existing project context.
- **Tool**: save_fact
- **Arguments**: 
    - user_id: "dev_user_01"
    - fact: "Migration requirements for PolarDB: must include high-availability features."

### Scenario 5: Decay & Temporal Relevance
**User Input**: "Forget about that old migration plan, we have an entirely new strategy."
**Agent Action**: Clear stale or irrelevant information to maintain the accuracy of future recalls.
- **Tool**: delete_all_memories
- **Arguments**: 
    - user_id: "dev_user_01"

# Security & Privacy
- **Data Isolation**: Memories are strictly isolated by  `user_id`. No cross-user data leakage is possible.
- **Encryption**: The script dynamically connects to the address in MEM0_HOST.
- **Compliance**: Powered by Alibaba Cloud PolarDB, adhering to global data protection standards.

# Tags
`Memory-as-a-Service` `Long-term-Context` `PolarDB` `Vector-Database` `Mem0` `Enterprise-AI`

# Limitations
- **Short-term Buffer**: Very recent facts (within the last few seconds) might still be indexing; use the current session context for immediate follow-ups.
- **Complexity Limit**: Avoid saving extremely long paragraphs as a single fact; break them into smaller, semantic statements for better retrieval accuracy.

