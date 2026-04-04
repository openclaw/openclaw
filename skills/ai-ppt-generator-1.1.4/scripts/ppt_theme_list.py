import os
import sys
import requests
import json


def ppt_theme_list(api_key: str):
    url = "https://qianfan.baidubce.com/v2/tools/ai_ppt/get_ppt_theme"
    headers = {
        "Authorization": "Bearer %s" % api_key,
        "X-Appbuilder-From": "openclaw",
    }
    response = requests.post(url, headers=headers)
    result = response.json()
    if "errno" in result and result["errno"] != 0:
        raise RuntimeError(result["errmsg"])
    themes = []
    count = 0
    for theme in result["data"]["ppt_themes"]:
        count += 1
        if count > 100:
            break
        themes.append({
            "style_name_list": theme["style_name_list"],
            "style_id": theme["style_id"],
            "tpl_id": theme["tpl_id"],
        })
    return themes


if __name__ == "__main__":
    api_key = os.getenv("BAIDU_API_KEY")
    if not api_key:
        print("Error: BAIDU_API_KEY  must be set in environment.")
        sys.exit(1)
    try:
        results = ppt_theme_list(api_key)
        print(json.dumps(results, ensure_ascii=False, indent=2))
    except Exception as e:
        exc_type, exc_value, exc_traceback = sys.exc_info()
        print(f"error type：{exc_type}")
        print(f"error message：{exc_value}")
        sys.exit(1)