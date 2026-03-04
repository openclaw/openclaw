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
      env:
        - MEM0_API_KEY  # API Key obtained from the Alibaba Cloud PolarDB Console.
        - MEM0_ORG_ID   # Your Organization ID
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
   - - **Service Host**: The connection is managed via `handler.py`. Ensure the host (IP or Domain) is correctly configured in the `_get_client()` function.
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
- **Encryption**: All data transmitted to `mem0test01.polardb.com` is encrypted via TLS 1.3.
- **Compliance**: Powered by Alibaba Cloud PolarDB, adhering to global data protection standards.

# Tags
`Memory-as-a-Service` `Long-term-Context` `PolarDB` `Vector-Database` `Mem0` `Enterprise-AI`

# Limitations
- **Short-term Buffer**: Very recent facts (within the last few seconds) might still be indexing; use the current session context for immediate follow-ups.
- **Complexity Limit**: Avoid saving extremely long paragraphs as a single fact; break them into smaller, semantic statements for better retrieval accuracy.

