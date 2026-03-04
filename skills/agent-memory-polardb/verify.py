import os
from handler import save_fact, search_memories

# 1. 模拟环境变量输入
os.environ["MEM0_API_KEY"] = "你的真实API_KEY"
os.environ["MEM0_ORG_ID"] = "你的真实ORG_ID"

print("--- 开始验证 PolarDB Mem0 存储 ---")
# 模拟 Agent 存入记忆
res_save = save_fact(fact="I am testing the PolarDB Mem0 skill integration.")
print(f"写入结果: {res_save}")

print("\n--- 开始验证 PolarDB Mem0 检索 ---")
# 模拟 Agent 检索记忆
res_search = search_memories(query="What am I testing?")
print(f"检索结果: {res_search}")
