#!/usr/bin/env python3
"""
Otter.ai CLI - Manage meeting transcripts

Usage:
    otter.py list [--limit N] [--json]
    otter.py get <speech_id> [--json]
    otter.py search <query> [--json]
    otter.py download <speech_id> [--format FORMAT] [--output PATH]
    otter.py upload <file>
    otter.py summary <speech_id>
    otter.py sync-twenty <speech_id> [--contact NAME] [--company NAME]
"""

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Optional

import requests
from requests_toolbelt.multipart.encoder import MultipartEncoder


class OtterClient:
    """Otter.ai API client"""
    
    API_BASE = "https://otter.ai/forward/api/v1/"
    S3_BASE = "https://s3.us-west-2.amazonaws.com/"
    
    def __init__(self):
        self._session = requests.Session()
        self._userid = None
        self._cookies = None
        self._logged_in = False
    
    def login(self, email: str, password: str) -> bool:
        """Authenticate with Otter.ai"""
        url = f"{self.API_BASE}login"
        self._session.auth = (email, password)
        
        resp = self._session.get(url, params={"username": email})
        if resp.status_code != 200:
            return False
        
        data = resp.json()
        self._userid = data.get("userid")
        self._cookies = resp.cookies.get_dict()
        self._logged_in = True
        return True
    
    def get_speeches(self, limit: int = 20, folder: int = 0) -> list:
        """Get list of transcripts"""
        if not self._logged_in:
            raise RuntimeError("Not logged in")
        
        url = f"{self.API_BASE}speeches"
        params = {
            "userid": self._userid,
            "folder": folder,
            "page_size": limit,
            "source": "owned"
        }
        
        resp = self._session.get(url, params=params)
        if resp.status_code != 200:
            return []
        
        return resp.json().get("speeches", [])
    
    def get_speech(self, speech_id: str) -> dict:
        """Get full transcript"""
        if not self._logged_in:
            raise RuntimeError("Not logged in")
        
        url = f"{self.API_BASE}speech"
        params = {"userid": self._userid, "otid": speech_id}
        
        resp = self._session.get(url, params=params)
        if resp.status_code != 200:
            return {}
        
        return resp.json().get("speech", {})
    
    def search(self, query: str, speech_id: Optional[str] = None, size: int = 100) -> list:
        """Search transcripts"""
        if not self._logged_in:
            raise RuntimeError("Not logged in")
        
        url = f"{self.API_BASE}advanced_search"
        params = {"query": query, "size": size}
        if speech_id:
            params["otid"] = speech_id
        
        resp = self._session.get(url, params=params)
        if resp.status_code != 200:
            return []
        
        return resp.json().get("hits", [])
    
    def download(self, speech_id: str, fmt: str = "txt") -> bytes:
        """Download transcript in specified format"""
        if not self._logged_in:
            raise RuntimeError("Not logged in")
        
        url = f"{self.API_BASE}bulk_export"
        params = {"userid": self._userid}
        data = {"formats": fmt, "speech_otid_list": [speech_id]}
        headers = {
            "x-csrftoken": self._cookies.get("csrftoken", ""),
            "referer": "https://otter.ai/"
        }
        
        resp = self._session.post(url, params=params, headers=headers, data=data)
        if resp.status_code != 200:
            return b""
        
        return resp.content
    
    def upload(self, filepath: str, content_type: str = "audio/mp4") -> dict:
        """Upload audio for transcription"""
        if not self._logged_in:
            raise RuntimeError("Not logged in")
        
        # Get upload params
        url = f"{self.API_BASE}speech_upload_params"
        resp = self._session.get(url, params={"userid": self._userid})
        if resp.status_code != 200:
            return {"error": "Failed to get upload params"}
        
        params_data = resp.json().get("data", {})
        
        # Upload to S3
        upload_url = f"{self.S3_BASE}speech-upload-prod"
        fields = dict(params_data)
        fields["success_action_status"] = str(fields.get("success_action_status", "201"))
        if "form_action" in fields:
            del fields["form_action"]
        
        with open(filepath, "rb") as f:
            fields["file"] = (os.path.basename(filepath), f, content_type)
            multipart = MultipartEncoder(fields=fields)
            resp = requests.post(
                upload_url,
                data=multipart,
                headers={"Content-Type": multipart.content_type}
            )
        
        if resp.status_code != 201:
            return {"error": f"Upload failed: {resp.status_code}"}
        
        # Parse S3 response
        import xml.etree.ElementTree as ET
        root = ET.fromstring(resp.text)
        bucket = root.find("Bucket").text if root.find("Bucket") is not None else ""
        key = root.find("Key").text if root.find("Key") is not None else ""
        
        # Finish upload
        finish_url = f"{self.API_BASE}finish_speech_upload"
        params = {
            "bucket": bucket,
            "key": key,
            "language": "en",
            "country": "us",
            "userid": self._userid
        }
        resp = self._session.get(finish_url, params=params)
        
        return resp.json() if resp.status_code == 200 else {"error": "Finish upload failed"}


def format_speech_list(speeches: list) -> str:
    """Format speech list for display"""
    lines = []
    for s in speeches:
        title = s.get("title", "Untitled")
        otid = s.get("otid", "")
        created = s.get("created", 0)
        duration = s.get("duration", 0)
        
        # Format timestamp
        if created:
            dt = datetime.fromtimestamp(created)
            date_str = dt.strftime("%Y-%m-%d %H:%M")
        else:
            date_str = "Unknown"
        
        # Format duration
        mins = duration // 60
        secs = duration % 60
        dur_str = f"{mins}m {secs}s"
        
        lines.append(f"• {title}")
        lines.append(f"  ID: {otid}")
        lines.append(f"  Date: {date_str} | Duration: {dur_str}")
        lines.append("")
    
    return "\n".join(lines)


def format_speech(speech: dict) -> str:
    """Format full speech for display"""
    title = speech.get("title", "Untitled")
    created = speech.get("created", 0)
    
    if created:
        dt = datetime.fromtimestamp(created)
        date_str = dt.strftime("%Y-%m-%d %H:%M")
    else:
        date_str = "Unknown"
    
    lines = [f"# {title}", f"Date: {date_str}", ""]
    
    # Get transcript text
    transcripts = speech.get("transcripts", [])
    for t in transcripts:
        speaker = t.get("speaker_name", "Speaker")
        text = t.get("transcript", "")
        start = t.get("start_offset", 0)
        
        mins = start // 60000
        secs = (start % 60000) // 1000
        
        lines.append(f"[{mins:02d}:{secs:02d}] {speaker}: {text}")
    
    return "\n".join(lines)


def extract_summary_text(speech: dict) -> str:
    """Extract plain text for summarization"""
    lines = []
    transcripts = speech.get("transcripts", [])
    
    for t in transcripts:
        speaker = t.get("speaker_name", "Speaker")
        text = t.get("transcript", "")
        lines.append(f"{speaker}: {text}")
    
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Otter.ai CLI")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # list
    list_p = subparsers.add_parser("list", help="List recent transcripts")
    list_p.add_argument("--limit", type=int, default=10, help="Number of results")
    
    # get
    get_p = subparsers.add_parser("get", help="Get full transcript")
    get_p.add_argument("speech_id", help="Speech ID")
    
    # search
    search_p = subparsers.add_parser("search", help="Search transcripts")
    search_p.add_argument("query", help="Search query")
    
    # download
    dl_p = subparsers.add_parser("download", help="Download transcript")
    dl_p.add_argument("speech_id", help="Speech ID")
    dl_p.add_argument("--format", default="txt", choices=["txt", "pdf", "docx", "srt"])
    dl_p.add_argument("--output", help="Output path")
    
    # upload
    up_p = subparsers.add_parser("upload", help="Upload audio for transcription")
    up_p.add_argument("file", help="Audio file path")
    
    # summary
    sum_p = subparsers.add_parser("summary", help="Get transcript text for summarization")
    sum_p.add_argument("speech_id", help="Speech ID")
    
    # sync-twenty
    sync_p = subparsers.add_parser("sync-twenty", help="Sync to Twenty CRM")
    sync_p.add_argument("speech_id", help="Speech ID")
    sync_p.add_argument("--contact", help="Contact name to link")
    sync_p.add_argument("--company", help="Company name to link")
    
    args = parser.parse_args()
    
    # Get credentials
    email = os.environ.get("OTTER_EMAIL")
    password = os.environ.get("OTTER_PASSWORD")
    
    if not email or not password:
        print("Error: OTTER_EMAIL and OTTER_PASSWORD environment variables required", file=sys.stderr)
        sys.exit(1)
    
    # Initialize client
    client = OtterClient()
    if not client.login(email, password):
        print("Error: Failed to login to Otter.ai", file=sys.stderr)
        sys.exit(1)
    
    # Execute command
    if args.command == "list":
        speeches = client.get_speeches(limit=args.limit)
        if args.json:
            print(json.dumps(speeches, indent=2))
        else:
            print(format_speech_list(speeches))
    
    elif args.command == "get":
        speech = client.get_speech(args.speech_id)
        if args.json:
            print(json.dumps(speech, indent=2))
        else:
            print(format_speech(speech))
    
    elif args.command == "search":
        results = client.search(args.query)
        if args.json:
            print(json.dumps(results, indent=2))
        else:
            for r in results:
                print(f"• {r.get('title', 'Untitled')} (ID: {r.get('otid', '')})")
                if r.get("highlight"):
                    print(f"  ...{r['highlight']}...")
                print()
    
    elif args.command == "download":
        content = client.download(args.speech_id, fmt=args.format)
        if content:
            output = args.output or f"{args.speech_id}.{args.format}"
            with open(output, "wb") as f:
                f.write(content)
            print(f"Downloaded to {output}")
        else:
            print("Error: Download failed", file=sys.stderr)
            sys.exit(1)
    
    elif args.command == "upload":
        if not os.path.exists(args.file):
            print(f"Error: File not found: {args.file}", file=sys.stderr)
            sys.exit(1)
        
        result = client.upload(args.file)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            if "error" in result:
                print(f"Error: {result['error']}", file=sys.stderr)
                sys.exit(1)
            print("Upload started. Transcription in progress...")
    
    elif args.command == "summary":
        speech = client.get_speech(args.speech_id)
        if not speech:
            print("Error: Speech not found", file=sys.stderr)
            sys.exit(1)
        
        title = speech.get("title", "Untitled")
        text = extract_summary_text(speech)
        
        output = {
            "title": title,
            "speech_id": args.speech_id,
            "transcript_text": text,
            "word_count": len(text.split())
        }
        
        if args.json:
            print(json.dumps(output, indent=2))
        else:
            print(f"Title: {title}")
            print(f"Words: {output['word_count']}")
            print("\n--- Transcript ---\n")
            print(text)
    
    elif args.command == "sync-twenty":
        # Check Twenty credentials
        twenty_url = os.environ.get("TWENTY_API_URL")
        twenty_token = os.environ.get("TWENTY_API_TOKEN")
        
        if not twenty_url or not twenty_token:
            print("Error: TWENTY_API_URL and TWENTY_API_TOKEN required for CRM sync", file=sys.stderr)
            sys.exit(1)
        
        speech = client.get_speech(args.speech_id)
        if not speech:
            print("Error: Speech not found", file=sys.stderr)
            sys.exit(1)
        
        title = speech.get("title", "Untitled")
        text = extract_summary_text(speech)
        duration = speech.get("duration", 0)
        created = speech.get("created_at")
        
        # Format date
        date_str = ""
        if created:
            try:
                dt = datetime.fromtimestamp(created)
                date_str = dt.strftime("%Y-%m-%d %H:%M")
            except:
                date_str = str(created)
        
        # Build markdown note
        markdown = f"""# Meeting Transcript: {title}

**Date:** {date_str}
**Duration:** {duration // 60}m {duration % 60}s
**Source:** Otter.ai

## Transcript

{text[:3000]}{"..." if len(text) > 3000 else ""}

---
*Synced from Otter.ai on {datetime.now().strftime("%Y-%m-%d %H:%M")}*
"""
        
        # Create note in Twenty
        headers = {
            "Authorization": f"Bearer {twenty_token}",
            "Content-Type": "application/json"
        }
        
        note_data = {
            "title": f"Transcript: {title}",
            "bodyV2": {
                "blocknote": "",
                "markdown": markdown
            }
        }
        
        resp = requests.post(
            f"{twenty_url}/rest/notes",
            headers=headers,
            json=note_data
        )
        
        if resp.status_code >= 400:
            print(f"Error creating note: {resp.status_code} {resp.text}", file=sys.stderr)
            sys.exit(1)
        
        result = resp.json()
        note_id = result.get("data", {}).get("createNote", {}).get("id")
        
        # Link to engagement if company specified
        if args.company and note_id:
            # Search for engagement by company name
            eng_resp = requests.get(
                f"{twenty_url}/rest/engagements",
                headers=headers
            )
            if eng_resp.status_code == 200:
                engagements = eng_resp.json().get("data", {}).get("engagements", [])
                company_lower = args.company.lower()
                for eng in engagements:
                    if company_lower in eng.get("name", "").lower():
                        # Link note to engagement
                        requests.post(
                            f"{twenty_url}/rest/noteTargets",
                            headers=headers,
                            json={"noteId": note_id, "engagementId": eng.get("id")}
                        )
                        print(f"Linked to engagement: {eng.get('name')}")
                        break
        
        print(f"✅ Created note in Twenty: {title}")
        print(f"   Note ID: {note_id}")
        if args.json:
            print(json.dumps({"note_id": note_id, "title": title}))


if __name__ == "__main__":
    main()
