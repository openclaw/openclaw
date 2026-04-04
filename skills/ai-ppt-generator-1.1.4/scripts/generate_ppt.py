import os
import random
import sys
import time

import requests
import json
import argparse

URL_PREFIX = "https://qianfan.baidubce.com/v2/tools/ai_ppt/"


class Style:
    def __init__(self, style_id, tpl_id):
        self.style_id = style_id
        self.tpl_id = tpl_id


class Outline:
    def __init__(self, chat_id, query_id, title, outline):
        self.chat_id = chat_id
        self.query_id = query_id
        self.title = title
        self.outline = outline


def get_ppt_theme(api_key: str):
    """Get a random PPT theme"""
    headers = {
        "Authorization": "Bearer %s" % api_key,
    }
    response = requests.post(URL_PREFIX + "get_ppt_theme", headers=headers)
    result = response.json()
    if "errno" in result and result["errno"] != 0:
        raise RuntimeError(result["errmsg"])

    style_index = random.randint(0, len(result["data"]["ppt_themes"]) - 1)
    theme = result["data"]["ppt_themes"][style_index]
    return Style(style_id=theme["style_id"], tpl_id=theme["tpl_id"])


def ppt_outline_generate(api_key: str, query: str):
    """Generate PPT outline"""
    headers = {
        "Authorization": "Bearer %s" % api_key,
        "X-Appbuilder-From": "openclaw",
        "Content-Type": "application/json"
    }
    headers.setdefault('Accept', 'text/event-stream')
    headers.setdefault('Cache-Control', 'no-cache')
    headers.setdefault('Connection', 'keep-alive')
    params = {
        "query": query,
    }
    title = ""
    outline = ""
    chat_id = ""
    query_id = ""
    with requests.post(URL_PREFIX + "generate_outline", headers=headers, json=params, stream=True) as response:
        for line in response.iter_lines():
            line = line.decode('utf-8')
            if line and line.startswith("data:"):
                data_str = line[5:].strip()
                delta = json.loads(data_str)
                if not title:
                    title = delta["title"]
                    chat_id = delta["chat_id"]
                    query_id = delta["query_id"]
                outline += delta["outline"]

    return Outline(chat_id=chat_id, query_id=query_id, title=title, outline=outline)


def ppt_generate(api_key: str, query: str, style_id: int = 0, tpl_id: int = None, web_content: str = None):
    """Generate PPT - simple version"""
    headers = {
        "Authorization": "Bearer %s" % api_key,
        "Content-Type": "application/json",
        "X-Appbuilder-From": "openclaw",
    }
    
    # Get theme
    if tpl_id is None:
        # Random theme
        style = get_ppt_theme(api_key)
        style_id = style.style_id
        tpl_id = style.tpl_id
        print(f"Using random template (tpl_id: {tpl_id})", file=sys.stderr)
    else:
        # Specific theme - use provided style_id (default 0)
        print(f"Using template tpl_id: {tpl_id}, style_id: {style_id}", file=sys.stderr)
    
    # Generate outline
    outline = ppt_outline_generate(api_key, query)
    
    # Generate PPT
    headers.setdefault('Accept', 'text/event-stream')
    headers.setdefault('Cache-Control', 'no-cache')
    headers.setdefault('Connection', 'keep-alive')
    params = {
        "query_id": int(outline.query_id),
        "chat_id": int(outline.chat_id),
        "query": query,
        "outline": outline.outline,
        "title": outline.title,
        "style_id": style_id,
        "tpl_id": tpl_id,
        "web_content": web_content,
        "enable_save_bos": True,
    }
    with requests.post(URL_PREFIX + "generate_ppt_by_outline", headers=headers, json=params, stream=True) as response:
        if response.status_code != 200:
            print(f"request failed, status code is {response.status_code}, error message is {response.text}")
            return []
        for line in response.iter_lines():
            line = line.decode('utf-8')
            if line and line.startswith("data:"):
                data_str = line[5:].strip()
                yield json.loads(data_str)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate PPT")
    parser.add_argument("--query", "-q", type=str, required=True, help="PPT topic")
    parser.add_argument("--style_id", "-si", type=int, default=0, help="Style ID (default: 0)")
    parser.add_argument("--tpl_id", "-tp", type=int, help="Template ID (optional)")
    parser.add_argument("--web_content", "-wc", type=str, default=None, help="Web content")
    args = parser.parse_args()

    api_key = os.getenv("BAIDU_API_KEY")
    if not api_key:
        print("Error: BAIDU_API_KEY must be set in environment.")
        sys.exit(1)
    
    try:
        start_time = int(time.time())
        results = ppt_generate(api_key, args.query, args.style_id, args.tpl_id, args.web_content)
        
        for result in results:
            if "is_end" in result and result["is_end"]:
                print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                end_time = int(time.time())
                print(json.dumps({"status": result["status"], "run_time": end_time - start_time}))
                
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)