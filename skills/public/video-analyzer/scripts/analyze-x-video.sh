#!/usr/bin/env bash
#
# X/Twitter Video Tweet Analysis
# Workflow: Download video → Extract audio → Speech recognition → Text summary
#

set -euo pipefail

# Configuration
DOWNLOAD_DIR="${HOME}/.openclaw/workspace/media/x-videos"
MAX_DURATION=600  # Max 10 minutes of video

# Show usage
usage() {
    echo "Usage: $0 <x-post-url>"
    echo ""
    echo "Example: $0 https://x.com/username/status/1234567890"
    exit 1
}

# Check arguments
if [ $# -eq 0 ]; then
    usage
fi

URL="$1"
mkdir -p "$DOWNLOAD_DIR"

echo "🎬 X/Twitter Video Analysis"
echo "============================"
echo ""

# Step 1: Get tweet text (Jina Reader)
echo "📄 Step 1: Getting tweet text..."
TWEET_TEXT=$(curl -s "https://r.jina.ai/${URL}" -H "X-Return-Format: text" 2>/dev/null || echo "")

if [ -n "$TWEET_TEXT" ]; then
    echo "✅ Tweet text retrieved successfully"
    echo ""
    echo "--- Tweet Content ---"
    echo "$TWEET_TEXT" | head -20
    echo "---------------------"
    echo ""
else
    echo "⚠️  Could not get tweet text, continuing to try downloading video..."
fi

# Step 2: Download video
echo ""
echo "📥 Step 2: Downloading video..."
cd "$DOWNLOAD_DIR"

# Check dependencies
if ! command -v yt-dlp &> /dev/null; then
    echo "❌ yt-dlp required: pip3 install yt-dlp"
    exit 1
fi

# Download with yt-dlp
VIDEO_FILE=$(yt-dlp \
    --no-warnings \
    --no-check-certificate \
    -f "best[ext=mp4]/best" \
    -o "%(id)s.%(ext)s" \
    --print filename \
    "$URL" 2>/dev/null || echo "")

if [ -z "$VIDEO_FILE" ] || [ ! -f "$VIDEO_FILE" ]; then
    echo "❌ Video download failed"
    echo ""
    echo "Possible reasons:"
    echo "  - X video has extra protection"
    echo "  - Link is not a public video"
    echo "  - yt-dlp needs update: yt-dlp -U"
    exit 1
fi

echo "✅ Video downloaded: $VIDEO_FILE"

# Check video duration
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO_FILE" 2>/dev/null | cut -d. -f1)
echo "⏱️  Video duration: ${DURATION}s"

if [ "$DURATION" -gt "$MAX_DURATION" ]; then
    echo "⚠️  Video exceeds ${MAX_DURATION}s, only processing first ${MAX_DURATION}s"
    DURATION=$MAX_DURATION
fi

# Step 3: Extract audio
echo ""
echo "🎵 Step 3: Extracting audio..."
AUDIO_FILE="${VIDEO_FILE%.*}.mp3"

if ! command -v ffmpeg &> /dev/null; then
    echo "❌ ffmpeg required"
    echo "  macOS: brew install ffmpeg"
    echo "  Linux: sudo apt install ffmpeg"
    exit 1
fi

ffmpeg -i "$VIDEO_FILE" -vn -ar 16000 -ac 1 -b:a 32k -t "$MAX_DURATION" "$AUDIO_FILE" -y 2>/dev/null

if [ ! -f "$AUDIO_FILE" ]; then
    echo "❌ Audio extraction failed"
    exit 1
fi

echo "✅ Audio extracted: $AUDIO_FILE"

# Step 4: Speech recognition (Whisper)
echo ""
echo "🗣️ Step 4: Speech recognition..."

# Check if whisper is installed
if ! command -v whisper &> /dev/null; then
    echo "⚠️  Whisper not installed"
    echo ""
    echo "Install:"
    echo "  pip3 install openai-whisper"
    echo ""
    echo "Audio file saved: $AUDIO_FILE"
    echo "You can transcribe it with another tool and send it to me"
    exit 0
fi

echo "Transcribing with Whisper..."
echo "(First run will auto-download model, may take a few minutes)"
echo ""

# Run whisper (output to file)
whisper "$AUDIO_FILE" --model small --language Chinese --output_format txt --output_dir "$(dirname "$AUDIO_FILE")" 2>/dev/null || true

# Read transcript file
TRANSCRIPT_FILE="${AUDIO_FILE%.*}.txt"
if [ -f "$TRANSCRIPT_FILE" ]; then
    TRANSCRIPT=$(cat "$TRANSCRIPT_FILE")
    echo "✅ Speech recognition complete"
    echo ""
    echo "--- Video Transcript ---"
    echo "$TRANSCRIPT"
    echo "------------------------"
else
    echo "⚠️  Speech recognition failed or no speech detected"
fi

echo ""
echo "✨ Processing complete!"
echo ""
echo "Files saved to:"
echo "  Video: $VIDEO_FILE"
echo "  Audio: $AUDIO_FILE"
if [ -f "$TRANSCRIPT_FILE" ]; then
    echo "  Transcript: $TRANSCRIPT_FILE"
fi
