import os
import json
import subprocess
from mem0 import Memory
from mem0 import MemoryClient

HOST = "http://8.136.94.73:8080"
API_KEY = "3gxjz9PA_d1Ydyi2lr-O2uRIGw-XQbsp7z73WwPoMIo"

def _run_curl(url, payload, method='POST'):
    """
    既然原生 Python 库被拦截，我们直接调用系统已验证通过的 curl 命令。
    这能彻底绕过 Python 网络库导致的 [Errno 9] 问题。
    """
    # 1. 无论 payload 是否为空，先初始化变量
    if payload is not None:
        input_data = json.dumps(payload, ensure_ascii=False)
    else:
        input_data = ""

    cmd = [
        'curl', '-s', '-X', method, url,
        '-H', f'Authorization: Token {API_KEY}',
        '-H', 'Content-Type: application/json',
        '--data-binary', '@-'
    ]

    try:
        result = subprocess.run(
            cmd, input=input_data, capture_output=True, 
            text=True, check=True, encoding='utf-8'
        )
        output = result.stdout.strip()
        if not output:
            return {"status": "success"}
        return json.loads(output)

        # 尝试解析 JSON
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            return {"status": "raw_output", "data": output}

    except subprocess.CalledProcessError as e:
        return {"error": f"Curl command failed: {e.stderr}"}
    except Exception as e:
        return {"error": str(e)}

def save_fact(user_id, fact):
    """保存事实：将 verify.py 传入的 fact 转发给 PolarDB"""
    url = f"{HOST}/v1/memories"
    payload = {
        "messages": [
            {"role": "user", "content": fact}
        ],
        "user_id": str(user_id)
    }
    return _run_curl(url, payload, method='POST')

def search_memories(user_id, query):
    """直接调用云端集成接口搜索记忆"""
    url = f"{HOST}/v2/memories/search"
    payload = {
        "query": query, 
        "user_id": str(user_id)
    }
    return _run_curl(url, payload, method='POST')

def delete_all_memories(user_id):
    """
    根据你验证成功的命令：参数必须放在 URL 的 query string 中
    """
    url = f"{HOST}/v1/memories?user_id={user_id}"
    payload = {"user_id": str(user_id)}
    return _run_curl(url, payload=None, method='DELETE')
