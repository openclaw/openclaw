#!/usr/bin/env python3
"""
使用 OpenRouter (OpenAI 兼容 API) 进行记忆搜索
"""

import os
import sys
import json
import argparse
from pathlib import Path
from openai import OpenAI

# 添加项目根目录到Python路径
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

from utils.file_utils import load_text

def load_env():
    """Load .env file"""
    env_path = project_root.parent.parent / ".env"
    if env_path.exists():
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                if '=' in line and not line.strip().startswith('#'):
                    key, value = line.strip().split('=', 1)
                    if key.startswith('export '):
                        key = key[7:].strip()
                    if key and value and key not in os.environ:
                        os.environ[key] = value.strip()

def load_config():
    """加载配置"""
    load_env()
    config_path = project_root / "config" / "kimi_config.json"
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
        
    # Resolve API keys from env
    if config.get("api_key") in ["MOONSHOT_API_KEY", "MONTHSHOT_API_KEY"]:
        config["api_key"] = os.environ.get("MOONSHOT_API_KEY", config["api_key"])
        
    if config.get("search_api_key") == "OPENROUTER_API_KEY":
        config["search_api_key"] = os.environ.get("OPENROUTER_API_KEY", config["search_api_key"])
        
    return config

def init_search_client(config):
    """初始化搜索客户端 (OpenRouter)"""
    client = OpenAI(
        api_key=config.get("search_api_key", config["api_key"]),
        base_url=config.get("search_base_url", "https://openrouter.ai/api/v1"),
        timeout=config.get("timeout", 30)
    )
    return client

def search_memory(query, limit=5):
    """搜索记忆"""
    config = load_config()
    client = init_search_client(config)
    
    # 简单的文本搜索作为示例，未来可以替换为向量搜索
    data_dir = project_root / "data" / "processed"
    results = []
    
    if data_dir.exists():
        for file_path in data_dir.glob("*.md"):
            try:
                content = load_text(file_path)
                if query in content:
                    results.append({
                        "date": file_path.stem,
                        "content": content[:500] + "..." # 只取前500字预览
                    })
            except Exception as e:
                print(f"Error reading {file_path}: {e}")
                continue
    
    # 限制结果数量
    results = results[:limit]
    
    if not results:
        return "没有找到相关的思考记录。"
    
    # 构建上下文
    context = "\n\n".join([f"Date: {r['date']}\nContent: {r['content']}" for r in results])
    
    prompt = config["analysis_prompts"].get("memory_search", "请根据以下上下文回答问题：")
    
    try:
        response = client.chat.completions.create(
            model=config.get("search_model", "openai/gpt-3.5-turbo"),
            messages=[
                {"role": "system", "content": "你是一个记忆助手，帮助用户回顾他们的思考记录。"},
                {"role": "user", "content": f"{prompt}\n\n问题：{query}\n\n相关记录：\n{context}"}
            ],
            temperature=0.3,
            max_tokens=1000
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        return f"搜索分析失败: {e}"

def main():
    parser = argparse.ArgumentParser(description="搜索思考记录记忆")
    parser.add_argument("query", help="搜索查询")
    args = parser.parse_args()
    
    print(f"🔍 正在搜索记忆: {args.query}...")
    answer = search_memory(args.query)
    print("\n💡 回答:\n")
    print(answer)

if __name__ == "__main__":
    main()
