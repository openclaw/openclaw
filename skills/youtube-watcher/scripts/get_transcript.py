#!/usr/bin/env python3
import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

def clean_vtt(content: str) -> str:
    """
    Clean WebVTT content to plain text.
    Removes headers, timestamps, and duplicate lines.
    """
    lines = content.splitlines()
    text_lines = []
    seen = set()
    
    timestamp_pattern = re.compile(r'\d{2}:\d{2}:\d{2}\.\d{3}\s-->\s\d{2}:\d{2}:\d{2}\.\d{3}')
    
    for line in lines:
        line = line.strip()
        if not line or line == 'WEBVTT' or line.isdigit():
            continue
        if timestamp_pattern.match(line):
            continue
        if line.startswith('NOTE') or line.startswith('STYLE'):
            continue
            
        if text_lines and text_lines[-1] == line:
            continue
            
        line = re.sub(r'<[^>]+>', '', line)
        
        text_lines.append(line)
        
    return '\n'.join(text_lines)

def get_transcript(url: str):
    with tempfile.TemporaryDirectory() as temp_dir:
        cmd = [
            "yt-dlp",
            "--write-subs",
            "--write-auto-subs",
            "--skip-download",
            "--sub-lang", "en",
            "--output", "subs",
            url
        ]
        
        try:
            subprocess.run(cmd, cwd=temp_dir, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            print(f"Error running yt-dlp: {e.stderr.decode()}", file=sys.stderr)
            sys.exit(1)
        except FileNotFoundError:
            print("Error: yt-dlp not found. Please install it.", file=sys.stderr)
            sys.exit(1)

        temp_path = Path(temp_dir)
        vtt_files = list(temp_path.glob("*.vtt"))
        
        if not vtt_files:
            print("No subtitles found.", file=sys.stderr)
            sys.exit(1)
            
        vtt_file = vtt_files[0]
        
        content = vtt_file.read_text(encoding='utf-8')
        clean_text = clean_vtt(content)
        print(clean_text)

def main():
    parser = argparse.ArgumentParser(description="Fetch YouTube transcript.")
    parser.add_argument("url", help="YouTube video URL")
    args = parser.parse_args()
    
    get_transcript(args.url)

if __name__ == "__main__":
    main()
