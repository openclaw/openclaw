#!/usr/bin/env bash
#
# X/Twitter Video Tweet Analysis
# Workflow: Get video URL via API → Download video → Extract audio → Speech recognition
# Fallback: If video download fails, return tweet text only
#

set -euo pipefail

# Configuration
DOWNLOAD_DIR="${HOME}/.openclaw/workspace/media/x-videos"
MAX_DURATION=600  # Max 10 minutes of video
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

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

# Extract tweet ID from URL
TWEET_ID=$(echo "$URL" | grep -oE '[0-9]+$' || echo "")
if [ -z "$TWEET_ID" ]; then
    echo "❌ Could not extract tweet ID from URL"
    exit 1
fi

# Step 1: Try VxTwitter API for video URL and tweet text
echo "📡 Step 1: Fetching tweet data via API..."
API_RESPONSE=$(curl -s "https://api.vxtwitter.com/status/${TWEET_ID}" 2>/dev/null || echo "")

if [ -z "$API_RESPONSE" ] || ! echo "$API_RESPONSE" | grep -q '"text"'; then
    echo "⚠️  API failed, falling back to Jina Reader..."
    TWEET_TEXT=$(curl -s "https://r.jina.ai/${URL}" -H "X-Return-Format: text" 2>/dev/null || echo "")
    VIDEO_URL=""
else
    # Parse tweet text from API (macOS compatible)
    TWEET_TEXT=$(echo "$API_RESPONSE" | sed -n 's/.*"text":"\([^"]*\)".*/\1/p' | head -1 || echo "")
    # Parse video URL from API (macOS compatible)
    VIDEO_URL=$(echo "$API_RESPONSE" | grep -o '"url":"[^"]*\.mp4[^"]*"' | head -1 | sed 's/"url":"//;s/"$//' || echo "")
fi

if [ -n "$TWEET_TEXT" ]; then
    echo "✅ Tweet text retrieved"
    echo ""
    echo "--- Tweet Content ---"
    echo "$TWEET_TEXT" | head -20
    echo "---------------------"
    echo ""
else
    echo "❌ Could not retrieve tweet text"
    exit 1
fi

# If no video URL from API, we can only provide text analysis
if [ -z "$VIDEO_URL" ]; then
    echo ""
    echo "⚠️  No video found or video is protected."
    echo "📄 Analysis based on tweet text only."
    echo ""
    echo "[System Note: Video was not accessible. This summary is based on tweet text only.]"
    exit 0
fi

echo "📹 Found video URL"

# Step 2: Download video directly
echo ""
echo "📥 Step 2: Downloading video..."
cd "$DOWNLOAD_DIR"

VIDEO_FILE="${TWEET_ID}.mp4"

if ! curl -sL --max-time 120 "$VIDEO_URL" -o "$VIDEO_FILE" 2>/dev/null; then
    echo "⚠️  Video download failed (X platform restrictions)"
    echo ""
    echo "📄 Tweet text analysis:"
    echo "$TWEET_TEXT"
    echo ""
    echo "[System Note: Video download was blocked. Analysis is based on tweet text only.]"
    exit 0
fi

# Check if download was successful
if [ ! -f "$VIDEO_FILE" ] || [ ! -s "$VIDEO_FILE" ]; then
    echo "⚠️  Downloaded file is empty or missing"
    echo "📄 Tweet text analysis:"
    echo "$TWEET_TEXT"
    echo ""
    echo "[System Note: Video download failed. Analysis is based on tweet text only.]"
    exit 0
fi

FILE_SIZE=$(du -h "$VIDEO_FILE" | cut -f1)
echo "✅ Video downloaded: $VIDEO_FILE ($FILE_SIZE)"

# Check video duration
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO_FILE" 2>/dev/null | cut -d. -f1 || echo "0")

if [ "$DURATION" -eq 0 ]; then
    echo "⚠️  Could not determine video duration"
    DURATION=$MAX_DURATION
fi

echo "⏱️  Video duration: ${DURATION}s"

if [ "$DURATION" -gt "$MAX_DURATION" ]; then
    echo "⚠️  Video exceeds ${MAX_DURATION}s, only processing first ${MAX_DURATION}s"
    DURATION=$MAX_DURATION
fi

# Step 3: Extract audio
echo ""
echo "🎵 Step 3: Extracting audio..."
AUDIO_FILE="${TWEET_ID}.mp3"

if ! command -v ffmpeg &>/dev/null; then
    echo "❌ ffmpeg required: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)"
    echo "📄 Tweet text: $TWEET_TEXT"
    exit 0
fi

if ! ffmpeg -i "$VIDEO_FILE" -vn -ar 16000 -ac 1 -b:a 32k -t "$MAX_DURATION" "$AUDIO_FILE" -y 2>/dev/null; then
    echo "⚠️  Audio extraction failed"
    echo "📄 Tweet text analysis:"
    echo "$TWEET_TEXT"
    exit 0
fi

if [ ! -f "$AUDIO_FILE" ]; then
    echo "⚠️  Audio file not created"
    echo "📄 Tweet text: $TWEET_TEXT"
    exit 0
fi

echo "✅ Audio extracted: $AUDIO_FILE"

# Step 4: Speech recognition (Whisper)
echo ""
echo "🗣️ Step 4: Speech recognition..."

# Check for whisper in PATH
WHISPER_PATH="$(command -v whisper 2>/dev/null)"
if [ -z "$WHISPER_PATH" ] || [ ! -x "$WHISPER_PATH" ]; then
    echo "⚠️  Whisper not installed"
    echo ""
    echo "Install: pip3 install openai-whisper"
    echo ""
    echo "📄 Tweet text:"
    echo "$TWEET_TEXT"
    echo ""
    echo "💾 Files saved:"
    echo "  Video: $DOWNLOAD_DIR/$VIDEO_FILE"
    echo "  Audio: $DOWNLOAD_DIR/$AUDIO_FILE"
    exit 0
fi

echo "Transcribing with Whisper..."
echo "(First run will auto-download model, may take a few minutes)"
echo ""

# Run whisper
if ! "$WHISPER_PATH" "$AUDIO_FILE" --model small --output_format txt --output_dir "$DOWNLOAD_DIR" 2>/dev/null; then
    echo "⚠️  Transcription failed"
    echo "📄 Tweet text: $TWEET_TEXT"
    exit 0
fi

# Read transcript
TRANSCRIPT_FILE="${DOWNLOAD_DIR}/${TWEET_ID}.txt"
if [ -f "$TRANSCRIPT_FILE" ]; then
    TRANSCRIPT=$(cat "$TRANSCRIPT_FILE")
    echo "✅ Speech recognition complete"
    echo ""
    echo "--- Video Transcript ---"
    echo "$TRANSCRIPT"
    echo "------------------------"
else
    echo "⚠️  Transcript file not found"
fi

echo ""
echo "✨ Processing complete!"
echo ""
echo "📊 Summary:"
echo "  Tweet text: ✅ Retrieved"
[ -f "$VIDEO_FILE" ] && echo "  Video: ✅ Downloaded"
[ -f "$AUDIO_FILE" ] && echo "  Audio: ✅ Extracted"
[ -f "$TRANSCRIPT_FILE" ] && echo "  Transcript: ✅ Generated"
echo ""
echo "📁 Files saved to: $DOWNLOAD_DIR"
ls -lh "$DOWNLOAD_DIR/${TWEET_ID}"* 2>/dev/null || true
