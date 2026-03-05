import os
import json
import subprocess
import urllib.parse
import urllib.request
import urllib.error
import sys

HOST = os.getenv("MEM0_HOST")
API_KEY = os.getenv("MEM0_API_KEY")

def _request_secure_curl(endpoint, method='POST', payload=None):
    """
    使用系统 curl 绕过 [Errno 9] 限制。
    通过 shell=False 和参数化调用防止命令注入。
    """
    if not HOST or not API_KEY:
        return {"error": "Environment config missing"}

    url = f"{HOST.rstrip('/')}{endpoint}"

    # 构建基础命令列表 (严格禁止 shell=True)
    cmd = [
        "curl", "-s", "-X", method,
        url,
        "-H", f"Authorization: Token {API_KEY}",
        "-H", "Content-Type: application/json"
    ]
    # 如果有数据，使用 --data 传入 JSON 字符串
    if payload:
        cmd.extend(["-d", json.dumps(payload)])

    try:
        # 使用 shell=False 确保参数作为独立的字符串传递，无法执行命令拼接
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            text=True, 
            timeout=15, 
            check=True
        )

        if not result.stdout.strip():
            return {"status": "success"}

        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        return {"error": f"Curl process failed: {e.stderr}"}
    except Exception as e:
        return {"error": f"Unexpected error: {str(e)}"}

def save_fact(user_id, fact):
    """保存事实：将 verify.py 传入的 fact 转发给 PolarDB"""
    """使用标准库存储事实"""
    return _request_secure_curl("/v1/memories", 'POST', {
        "messages": [{"role": "user", "content": fact}],
        "user_id": str(user_id)
    })

def search_memories(user_id, query):
    """直接调用云端集成接口搜索记忆,使用标准库搜索记忆"""
    return _request_secure_curl("/v2/memories/search", 'POST', {
        "query": query, 
        "user_id": str(user_id)
    })

def delete_all_memories(user_id):
    """
    根据你验证成功的命令：参数必须放在 URL 的 query string 中
    """
    # 构造带 Query String 的 URL
    encoded_id = urllib.parse.quote(str(user_id))
    endpoint = f"/v1/memories?user_id={encoded_id}"
    return _request_secure_curl(endpoint, 'DELETE')
