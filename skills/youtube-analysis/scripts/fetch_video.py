#!/usr/bin/env python3
"""Fetch video metadata and subtitles using yt-dlp.

Usage:
  fetch_video.py <url> [--download-video] [--subtitle-lang LANG] [--playlist-limit N]

Output:
  JSON to stdout with video metadata and paths to downloaded files.
"""
import argparse
import json
import os
import sys

try:
    import yt_dlp
except ImportError:
    print("[ERROR] yt-dlp is not installed. Run: brew install yt-dlp", file=sys.stderr)
    sys.exit(1)


def parse_args():
    parser = argparse.ArgumentParser(description="Fetch video metadata and subtitles via yt-dlp")
    parser.add_argument("url", help="Video, playlist, or channel URL")
    parser.add_argument("--download-video", action="store_true", help="Download full video file")
    parser.add_argument("--subtitle-lang", default="en", help="Subtitle language (default: en)")
    parser.add_argument("--playlist-limit", type=int, default=10, help="Max videos from playlist (default: 10)")
    parser.add_argument("--cookies-from-browser", default=None, help="Browser to extract cookies from (chrome, firefox, safari, etc.)")
    return parser.parse_args()


def get_output_dir(video_id):
    base = os.path.expanduser("~/.openclaw/youtube-analysis")
    out = os.path.join(base, video_id)
    os.makedirs(out, exist_ok=True)
    return out


def fetch_single(url, subtitle_lang="en", download_video=False, cookies_from_browser=None):
    """Extract metadata and subtitles for a single video."""
    # First pass: extract metadata without downloading
    info_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
    }
    if cookies_from_browser:
        info_opts["cookiesfrombrowser"] = (cookies_from_browser,)
    with yt_dlp.YoutubeDL(info_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if info is None:
        print(f"[ERROR] Could not extract info from {url}", file=sys.stderr)
        sys.exit(1)

    video_id = info.get("id", "unknown")
    out_dir = get_output_dir(video_id)

    # Save raw metadata
    metadata = {
        "video_id": video_id,
        "title": info.get("title", ""),
        "channel": info.get("channel", info.get("uploader", "")),
        "duration": info.get("duration", 0),
        "views": info.get("view_count", 0),
        "upload_date": info.get("upload_date", ""),
        "description": info.get("description", ""),
        "subtitle_file": None,
        "video_file": None,
    }

    meta_path = os.path.join(out_dir, "metadata.json")
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    # Second pass: download subtitles (and optionally video)
    dl_opts = {
        "quiet": True,
        "no_warnings": True,
        "outtmpl": os.path.join(out_dir, "%(id)s.%(ext)s"),
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": [subtitle_lang],
        "subtitlesformat": "vtt",
        "skip_download": not download_video,
    }
    if cookies_from_browser:
        dl_opts["cookiesfrombrowser"] = (cookies_from_browser,)

    if download_video:
        dl_opts["format"] = "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
        dl_opts["merge_output_format"] = "mp4"

    with yt_dlp.YoutubeDL(dl_opts) as ydl:
        ydl.download([url])

    # Find downloaded subtitle file
    for ext in ["vtt", "srt"]:
        sub_path = os.path.join(out_dir, f"{video_id}.{subtitle_lang}.{ext}")
        if os.path.exists(sub_path):
            metadata["subtitle_file"] = sub_path
            break

    # Find downloaded video file
    if download_video:
        video_path = os.path.join(out_dir, f"{video_id}.mp4")
        if os.path.exists(video_path):
            metadata["video_file"] = video_path

    # Update metadata file with paths
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    return metadata


def fetch_playlist(url, subtitle_lang="en", download_video=False, playlist_limit=10, cookies_from_browser=None):
    """Resolve a playlist/channel and fetch each video."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": True,
        "playlistend": playlist_limit,
    }
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if info is None:
        print(f"[ERROR] Could not extract playlist info from {url}", file=sys.stderr)
        sys.exit(1)

    entries = info.get("entries", [])
    if not entries:
        # Not a playlist — treat as single video
        return None

    playlist_title = info.get("title", "Untitled Playlist")
    videos = []
    for entry in entries[:playlist_limit]:
        entry_url = entry.get("url") or entry.get("webpage_url")
        if not entry_url:
            continue
        try:
            video = fetch_single(entry_url, subtitle_lang, download_video, cookies_from_browser)
            videos.append(video)
            print(f"[OK] Fetched {len(videos)}/{min(len(entries), playlist_limit)}: {video.get('title', 'unknown')}", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] Skipping entry: {e}", file=sys.stderr)

    return {
        "playlist_title": playlist_title,
        "video_count": len(videos),
        "total_available": len(entries),
        "videos": videos,
    }


def looks_like_playlist(url):
    """Heuristic: avoid double-fetching single video URLs."""
    indicators = ["playlist?", "/playlist/", "/channel/", "/c/", "/@", "/videos", "/playlists"]
    return any(ind in url for ind in indicators)


def main():
    args = parse_args()

    result = None
    if looks_like_playlist(args.url):
        result = fetch_playlist(args.url, args.subtitle_lang, args.download_video, args.playlist_limit, args.cookies_from_browser)

    if result is None:
        # Single video (or playlist heuristic didn't match)
        result = fetch_single(args.url, args.subtitle_lang, args.download_video, args.cookies_from_browser)

    json.dump(result, sys.stdout, indent=2)
    print()  # trailing newline


if __name__ == "__main__":
    main()
