import os
import requests
import sys


def check_openai(key):
    try:
        response = requests.get(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {key}"},
            timeout=10,
        )
        if response.status_code == 200:
            return True, response.json()
        return False, response.status_code
    except Exception as e:
        return False, str(e)


def check_gemini(key):
    try:
        response = requests.get(
            f"https://generativelanguage.googleapis.com/v1beta/models?key={key}", timeout=10
        )
        if response.status_code == 200:
            return True, response.json()
        return False, response.status_code
    except Exception as e:
        return False, str(e)


def check_anthropic(key):
    try:
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-3-haiku-20240307",
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}],
            },
            timeout=10,
        )
        if response.status_code == 200:
            return True, "Valid"
        return False, response.status_code
    except Exception as e:
        return False, str(e)


if __name__ == "__main__":
    key = sys.argv[1]
    provider = sys.argv[2]
    if provider == "openai":
        print(check_openai(key))
    elif provider == "gemini":
        print(check_gemini(key))
    elif provider == "anthropic":
        print(check_anthropic(key))
