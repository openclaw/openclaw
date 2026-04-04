import os
import json
import time
import requests
import argparse
import sys
from pathlib import Path

# Constants
DEFAULT_TOKEN = "2aeda3bcefac46a3"
BASE_URL = "https://hfw-api.hifly.cc/api/v2/hifly"
MEMORY_FILE = Path(__file__).parent / "memory.json"

def get_token():
    token = os.environ.get("HIFLY_API_TOKEN")
    if not token:
        token = DEFAULT_TOKEN
        print(f"Warning: Using default free-tier token ({DEFAULT_TOKEN}). Videos <30s only, watermarked.")
    return token

def get_headers():
    return {
        "Authorization": f"Bearer {get_token()}",
        "Content-Type": "application/json"
    }

def load_memory():
    if MEMORY_FILE.exists():
        with open(MEMORY_FILE, 'r') as f:
            return json.load(f)
    return {}

def save_memory(memory):
    with open(MEMORY_FILE, 'w') as f:
        json.dump(memory, f, indent=2)

def resolve_alias(alias_or_id, kind):
    memory = load_memory()
    # Check if authorized kind exists in memory
    if kind in memory and alias_or_id in memory[kind]:
        return memory[kind][alias_or_id]
    return alias_or_id

def save_alias(alias, value, kind):
    memory = load_memory()
    if kind not in memory:
        memory[kind] = {}
    memory[kind][alias] = value
    save_memory(memory)
    print(f"Saved alias '{alias}' -> '{value}' for {kind}")

def check_task_status(task_id, task_type="video"):
    """
    Polls task status.
    task_type: 'video' or 'voice'
    """
    url = f"{BASE_URL}/{task_type}/task"
    params = {"task_id": task_id}
    headers = get_headers()
    
    print(f"Waiting for task {task_id} to complete...")
    while True:
        try:
            resp = requests.get(url, headers=headers, params=params)
            resp.raise_for_status()
            data = resp.json()
            
            # Status: 1:Waiting, 2:Processing, 3:Success, 4:Failed
            status = data.get("status")
            
            if status == 3:
                result_url = data.get("video_Url") or data.get("demo_url")
                print("\nTask Completed!")
                if "voice" in data:
                    print(f"Voice ID: {data['voice']}")
                return result_url
            elif status == 4:
                print(f"\nTask Failed: {data.get('message')}")
                return None
            
            print(".", end="", flush=True)
            time.sleep(2)
        except KeyboardInterrupt:
            print("\nPolling cancelled by user.")
            return None
        except Exception as e:
            print(f"\nError checking status: {e}")
            return None

def poll_avatar_task(task_id):
    url = f"{BASE_URL}/avatar/task"
    params = {"task_id": task_id}
    headers = get_headers()
    
    print(f"Waiting for avatar task {task_id}...")
    while True:
        try:
            resp = requests.get(url, headers=headers, params=params)
            resp.raise_for_status()
            data = resp.json()
            status = data.get("status")
            
            if status == 3:
                return data.get("avatar")
            elif status == 4:
                print(f"\nAvatar Task Failed: {data.get('message')}")
                return None
            
            print(".", end="", flush=True)
            time.sleep(2)
        except KeyboardInterrupt:
            return None
        except Exception:
            return None

def upload_file(file_path):
    file_path = Path(file_path)
    if not file_path.exists():
        print(f"Error: File not found: {file_path}")
        return None, None
    
    ext = file_path.suffix.lstrip('.')
    
    # 1. Get Upload URL
    url = f"{BASE_URL}/tool/create_upload_url"
    payload = {"file_extension": ext}
    headers = get_headers()
    
    try:
        resp = requests.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code", 0) != 0:
            print(f"Error getting upload URL: {data}")
            return None, None
            
        upload_url = data.get("upload_url")
        file_id = data.get("file_id")
        content_type = data.get("content_type")
        
        # 2. Upload content
        print(f"Uploading {file_path.name}...")
        with open(file_path, 'rb') as f:
            headers_put = {"Content-Type": content_type}
            resp_put = requests.put(upload_url, data=f, headers=headers_put)
            resp_put.raise_for_status()
            
        print(f"Upload successful. File ID: {file_id}")
        return file_id, upload_url
        
    except Exception as e:
        print(f"Upload failed: {e}")
        return None, None

def list_avatars():
    url = f"{BASE_URL}/avatar/list"
    params = {"page": 1, "size": 50, "kind": 2} # kind 2 = public
    resp = requests.get(url, headers=get_headers(), params=params)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") == 0:
        for item in data.get("data", []):
            print(f"ID: {item['avatar']} | Name: {item['title']}")
    else:
        print(f"Error: {data}")

def list_voices():
    url = f"{BASE_URL}/voice/list"
    params = {"page": 1, "size": 50, "kind": 1} 
    resp = requests.get(url, headers=get_headers(), params=params)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") == 0:
        for item in data.get("data", []):
             print(f"ID: {item['voice']} | Name: {item['title']} | Type: {item['type']}")
    else:
        print(f"Error: {data}")

def handle_media_input(input_val):
    """
    Handles input that can be either a URL or a local file path.
    Returns (url_or_file_id, is_file_id)
    """
    if not input_val:
        return None, False
        
    # Check if URL
    if input_val.startswith("http://") or input_val.startswith("https://"):
        return input_val, False
        
    # Assume local file
    file_id, _ = upload_file(input_val)
    if file_id:
        return file_id, True
    return None, False

def create_video(text=None, audio=None, avatar_id=None, title="Generated Video"):
    if not avatar_id:
        print("Error: avatar_id is required")
        return

    avatar_id = resolve_alias(avatar_id, "avatar")
    
    if audio:
        url = f"{BASE_URL}/video/create_by_audio"
        media_val, is_file_id = handle_media_input(audio)
        if not media_val:
            return

        payload = {
            "title": title,
            "avatar": avatar_id
        }
        if is_file_id:
             payload["file_id"] = media_val # Assuming file_id supported for audio driver
             # Docs for create_by_audio usually take audio_url. 
             # Let's check docs again or assume file_id works as consistent API design.
             # Actually, previous docs chunk 12 only showed audio_url. 
             # But create_by_video (Chunk 7) supports file_id. 
             # I will try to use 'audio_url' key for URL and 'file_id' key for file ID if possible, 
             # or maybe the API treats audio_url as file_id? Unlikely.
             # I'll stick to 'audio_url' for URL. For file_id, I'll add 'file_id' to payload.
        else:
             payload["audio_url"] = media_val

    elif text:
        # Should call create_video_tts but here we are
        print("Error: For TTS use create_video --type tts")
        return
    else:
        print("Error: Either text or audio is required")
        return

    # Helper for POST
    headers = get_headers()
    try:
        resp = requests.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") == 0:
            task_id = data.get("task_id")
            print(f"Task started: {task_id}")
            video_url = check_task_status(task_id, "video")
            if video_url:
                print(f"Video URL: {video_url}")
        else:
             print(f"API Error: {data}")
    except Exception as e:
        print(f"Request failed: {e}")

def create_video_tts(text, avatar_id, voice_id, title="TTS Video"):
    avatar_id = resolve_alias(avatar_id, "avatar")
    voice_id = resolve_alias(voice_id, "voice")
    
    url = f"{BASE_URL}/video/create_by_tts"
    payload = {
        "title": title,
        "text": text,
        "avatar": avatar_id,
        "voice": voice_id
    }
    
    headers = get_headers()
    try:
        resp = requests.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") == 0:
            task_id = data.get("task_id")
            print(f"Task started: {task_id}")
            video_url = check_task_status(task_id, "video")
            if video_url:
                print(f"Video URL: {video_url}")
        else:
             print(f"API Error: {data}")
    except Exception as e:
        print(f"Request failed: {e}")

def create_talking_photo(image, text=None, voice_id=None, title="Talking Photo"):
    # 1. Create Avatar from Image
    print("Step 1: Creating Avatar from Image...")
    
    media_val, is_file_id = handle_media_input(image)
    if not media_val:
        print("Error: Invalid image input.")
        return

    url = f"{BASE_URL}/avatar/create_by_image"
    payload = {
        "title": title,
        "model": 2
    }
    if is_file_id:
        payload["file_id"] = media_val
    else:
        payload["image_url"] = media_val
        
    headers = get_headers()
    avatar_id = None
    
    try:
        resp = requests.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") == 0:
            task_id = data.get("task_id")
            avatar_id = poll_avatar_task(task_id)
        else:
             print(f"API Error (Avatar Create): {data}")
             return
    except Exception as e:
        print(f"Request failed: {e}")
        return

    if not avatar_id:
        print("Failed to create avatar.")
        return
        
    print(f"Avatar Created: {avatar_id}")
    
    # 2. Create Video
    # If text is provided, use TTS.
    if text and voice_id:
        print("Step 2: Generating Video...")
        create_video_tts(text, avatar_id, voice_id, title=title)
    else:
        print(f"Avatar created successfully with ID: {avatar_id}. Provide text/voice to generate video.")

def clone_voice(audio, title="Cloned Voice"):
    media_val, is_file_id = handle_media_input(audio)
    if not media_val:
        print("Error: Invalid audio input.")
        return

    url = f"{BASE_URL}/voice/create"
    payload = {
        "title": title,
        "voice_type": 8
    }
    if is_file_id:
        payload["file_id"] = media_val 
    else:
        payload["audio_url"] = media_val
        
    headers = get_headers()
    try:
        resp = requests.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") == 0:
            task_id = data.get("task_id")
            print(f"Voice Clone Task Started: {task_id}")
            check_task_status(task_id, "voice")
        else:
             print(f"API Error: {data}")
    except Exception as e:
        print(f"Request failed: {e}")

def main():
    parser = argparse.ArgumentParser(description="HiFly Agent Skill Client")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # List Avatars
    subparsers.add_parser("list_public_avatars", help="List public avatars")
    
    # List Voices
    subparsers.add_parser("list_public_voices", help="List public voices")

    # Manage Memory
    mem_parser = subparsers.add_parser("manage_memory", help="Manage local aliases")
    mem_parser.add_argument("action", choices=["add", "list"], help="Action")
    mem_parser.add_argument("alias", nargs="?", help="Alias name")
    mem_parser.add_argument("value", nargs="?", help="Value (ID)")
    mem_parser.add_argument("--kind", choices=["avatar", "voice"], default="avatar", help="Kind of alias")

    # Create Video
    vid_parser = subparsers.add_parser("create_video", help="Create video")
    vid_parser.add_argument("--type", choices=["tts", "audio"], default="tts")
    vid_parser.add_argument("--text", help="Text to speak")
    vid_parser.add_argument("--audio", help="Audio URL or Local File Path")
    vid_parser.add_argument("--avatar", required=True, help="Avatar ID/Alias")
    vid_parser.add_argument("--voice", help="Voice ID/Alias (required for TTS)")
    
    # create_talking_photo
    tp_parser = subparsers.add_parser("create_talking_photo", help="Create talking photo video")
    tp_parser.add_argument("--image", required=True, help="Image URL or Local File Path")
    tp_parser.add_argument("--text", help="Text to speak")
    tp_parser.add_argument("--voice", help="Voice ID/Alias")
    tp_parser.add_argument("--title", default="Talking Photo", help="Title")

    # clone_voice
    cv_parser = subparsers.add_parser("clone_voice", help="Clone voice")
    cv_parser.add_argument("--audio", required=True, help="Audio URL or Local File Path")
    cv_parser.add_argument("--title", default="Cloned Voice", help="Voice Title")

    # check_task
    ct_parser = subparsers.add_parser("check_task", help="Check task status")
    ct_parser.add_argument("--id", required=True, help="Task ID")
    ct_parser.add_argument("--type", choices=["video", "voice", "avatar"], default="video", help="Task Type")

    args = parser.parse_args()

    if args.command == "list_public_avatars":
        list_avatars()
    elif args.command == "list_public_voices":
        list_voices()
    elif args.command == "manage_memory":
        if args.action == "add":
            if args.alias and args.value:
                save_alias(args.alias, args.value, args.kind)
            else:
                print("Alias and Value required for add")
        elif args.action == "list":
            print(json.dumps(load_memory(), indent=2))
    elif args.command == "create_video":
        if args.type == "tts":
            create_video_tts(args.text, args.avatar, args.voice)
        elif args.type == "audio":
            create_video(audio=args.audio, avatar_id=args.avatar)
    elif args.command == "create_talking_photo":
        create_talking_photo(image=args.image, text=args.text, voice_id=args.voice, title=args.title)
    elif args.command == "clone_voice":
        clone_voice(audio=args.audio, title=args.title)
    elif args.command == "check_task":
        if args.type == "avatar":
            res = poll_avatar_task(args.id)
        else:
            res = check_task_status(args.id, args.type)
        if res:
            print(f"Result: {res}")

if __name__ == "__main__":
    main()
