import time
from handler import save_fact, search_memories, delete_all_memories

def run_test():
    user_id = "test_user_999"
    test_fact = "我最喜欢的食物是麻婆豆腐。"

    print("---  开始闭环功能测试 ---")

    # 1. 清理环境（防止旧数据干扰）
    print("\n[Step 1] 清理旧数据...")
    delete_all_memories(user_id)

    # 2. 存储新事实
    print(f"\n[Step 2] 存储事实: '{test_fact}'")
    save_res = save_fact(user_id, test_fact)
    print(f"响应: {save_res}")

    # 给服务器一点点处理时间（索引同步）
    time.sleep(30)

    # 3. 搜索验证
    print("\n[Step 3] 搜索关键词: '食物'...")
    search_res = search_memories(user_id, "食物")
    
    # 兼容处理：Mem0 有时返回列表，有时返回带 results 的字典
    results = search_res.get('results', []) if isinstance(search_res, dict) else search_res

    if len(results) > 0:
        print(f"✅ 搜索成功，找到内容: {results}")
    else:
        print("❌ 搜索失败：未找到刚存入的内容。")
        return

     # 4. 执行删除
    print("\n[Step 4] 删除该用户所有记忆...")
    del_res = delete_all_memories(user_id)
    print(f"响应: {del_res}")

    # 5. 最终搜索验证（应该是搜不到）
    print("\n[Step 5] 再次搜索相同关键词...")
    final_res = search_memories(user_id, "食物")
    final_results = final_res.get('results', []) if isinstance(final_res, dict) else final_res

    if len(final_results) == 0:
        print("✨ 闭环测试成功：数据已彻底删除！")
    else:
        print(f"⚠️ 闭环测试异常：删除后依然能搜到内容: {final_results}")
if __name__ == "__main__":
    run_test()
