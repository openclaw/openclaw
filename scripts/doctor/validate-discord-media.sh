#!/bin/bash
# Discord media attachment validator
# Addresses #20906: Discord media can bypass content validation

set -e

echo "🎨 Discord Media Validation Checker"
echo "===================================="
echo ""

CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
LOGS_DIR="${HOME}/.openclaw/logs"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config file not found: $CONFIG_FILE"
    exit 1
fi

echo "🔍 Checking Discord channel configuration..."
echo ""

# Check if Discord channel is enabled
DISCORD_ENABLED=$(jq -r '.channels.discord.enabled // false' "$CONFIG_FILE" 2>/dev/null)

if [ "$DISCORD_ENABLED" != "true" ]; then
    echo "ℹ️  Discord channel not enabled"
    echo ""
    echo "This check is only relevant if you're using Discord integration."
    exit 0
fi

echo "✅ Discord channel enabled"
echo ""

ISSUES=0

# Check media handling configuration
echo "📋 Media Handling Configuration"
echo "==============================="
echo ""

MEDIA_ENABLED=$(jq -r '.channels.discord.media.enabled // true' "$CONFIG_FILE" 2>/dev/null)
MEDIA_MAX_SIZE=$(jq -r '.channels.discord.media.maxSize // "25000000"' "$CONFIG_FILE" 2>/dev/null)
MEDIA_ALLOWED_TYPES=$(jq -r '.channels.discord.media.allowedTypes // [] | join(", ")' "$CONFIG_FILE" 2>/dev/null)

echo "Media enabled: $MEDIA_ENABLED"
echo "Max size: $((MEDIA_MAX_SIZE / 1000000))MB"

if [ -z "$MEDIA_ALLOWED_TYPES" ] || [ "$MEDIA_ALLOWED_TYPES" = "" ]; then
    echo "⚠️  Allowed types: ALL (no restrictions)"
    echo ""
    echo "   Risk: Users can send any file type, including:"
    echo "   - Executable files (.exe, .sh, .bat, .app)"
    echo "   - Archive bombs (.zip, .tar.gz)"
    echo "   - Malicious documents (.pdf with exploits)"
    echo "   - HTML/SVG with embedded scripts"
    echo ""
    ((ISSUES++))
else
    echo "Allowed types: $MEDIA_ALLOWED_TYPES"
fi

echo ""

# Check content validation settings
echo "🛡️  Content Validation"
echo "====================="
echo ""

VALIDATE_MIME=$(jq -r '.channels.discord.media.validateMimeType // false' "$CONFIG_FILE" 2>/dev/null)
SCAN_MALWARE=$(jq -r '.channels.discord.media.scanMalware // false' "$CONFIG_FILE" 2>/dev/null)
CHECK_SIZE_BEFORE_DOWNLOAD=$(jq -r '.channels.discord.media.checkSizeBeforeDownload // false' "$CONFIG_FILE" 2>/dev/null)

echo "Validate MIME type: $VALIDATE_MIME"
if [ "$VALIDATE_MIME" != "true" ]; then
    echo "   ⚠️  Files not validated by actual content type"
    echo "   Risk: .jpg file could actually be .exe"
    echo ""
    ((ISSUES++))
fi

echo "Scan for malware: $SCAN_MALWARE"
if [ "$SCAN_MALWARE" != "true" ]; then
    echo "   ⚠️  No malware scanning configured"
    echo "   Risk: Malicious files accepted without scanning"
    echo ""
    ((ISSUES++))
fi

echo "Check size before download: $CHECK_SIZE_BEFORE_DOWNLOAD"
if [ "$CHECK_SIZE_BEFORE_DOWNLOAD" != "true" ]; then
    echo "   ⚠️  Files downloaded before size check"
    echo "   Risk: Large files consume memory/disk before rejection"
    echo ""
    ((ISSUES++))
fi

echo ""

# Check URL validation
echo "🔗 URL Validation"
echo "================="
echo ""

VALIDATE_DISCORD_CDN=$(jq -r '.channels.discord.media.validateDiscordCdn // false' "$CONFIG_FILE" 2>/dev/null)

echo "Validate Discord CDN: $VALIDATE_DISCORD_CDN"
if [ "$VALIDATE_DISCORD_CDN" != "true" ]; then
    echo "   ⚠️  Media URLs not restricted to Discord CDN"
    echo "   Risk: Users can inject arbitrary URLs via message embeds"
    echo "   Expected: cdn.discordapp.com, media.discordapp.net"
    echo ""
    ((ISSUES++))
fi

echo ""

# Check for historical bypass attempts
echo "📊 Historical Analysis"
echo "======================"
echo ""

if [ -d "$LOGS_DIR" ]; then
    echo "Scanning logs for potential bypass attempts..."
    echo ""

    # Check for suspicious file extensions
    SUSPICIOUS_EXTENSIONS=("exe" "sh" "bat" "app" "dll" "so" "dylib" "scr" "com" "pif" "cmd" "vbs" "js" "jar")

    for ext in "${SUSPICIOUS_EXTENSIONS[@]}"; do
        ATTEMPTS=$(grep -r "discord.*attachment.*\.$ext" "$LOGS_DIR" 2>/dev/null | wc -l || echo "0")
        if [ "$ATTEMPTS" -gt 0 ]; then
            echo "⚠️  Found $ATTEMPTS .$ext attachment(s) in logs"
            ((ISSUES++))
        fi
    done

    # Check for MIME type mismatches
    MIME_MISMATCHES=$(grep -r "MIME.*mismatch.*discord" "$LOGS_DIR" 2>/dev/null | wc -l || echo "0")
    if [ "$MIME_MISMATCHES" -gt 0 ]; then
        echo "⚠️  Found $MIME_MISMATCHES MIME type mismatch(es)"
        echo "   Files claiming to be one type but actually another"
        ((ISSUES++))
    fi

    # Check for oversized downloads
    SIZE_VIOLATIONS=$(grep -r "discord.*media.*size.*exceed" "$LOGS_DIR" 2>/dev/null | wc -l || echo "0")
    if [ "$SIZE_VIOLATIONS" -gt 0 ]; then
        echo "⚠️  Found $SIZE_VIOLATIONS size limit violation(s)"
    fi

    # Check for non-Discord CDN URLs
    NON_CDN_URLS=$(grep -r "discord.*media.*url" "$LOGS_DIR" 2>/dev/null | grep -v "cdn.discordapp.com\|media.discordapp.net" | wc -l || echo "0")
    if [ "$NON_CDN_URLS" -gt 0 ]; then
        echo "⚠️  Found $NON_CDN_URLS non-Discord CDN URL(s)"
        echo "   Media URLs not from official Discord CDN"
        ((ISSUES++))
    fi

    if [ "$ISSUES" -eq 0 ]; then
        echo "✅ No suspicious activity detected in logs"
    fi
else
    echo "ℹ️  Logs directory not found, skipping historical analysis"
fi

echo ""
echo "📊 Summary"
echo "=========="
echo ""

if [ "$ISSUES" -eq 0 ]; then
    echo "✅ Discord media validation appears properly configured"
    echo ""
    echo "💡 Best practices being followed:"
    echo "   - File type restrictions enabled"
    echo "   - MIME type validation active"
    echo "   - Size checks before download"
    echo "   - Discord CDN validation enforced"
    echo ""
    exit 0
fi

echo "⚠️  Found $ISSUES potential issue(s)"
echo ""
echo "⚠️  Discord Media Bypass Risk (#20906)"
echo ""
echo "Discord media attachments can bypass security validation if not"
echo "properly configured. This can lead to:"
echo ""
echo "1. Malicious file execution (if downloaded and opened)"
echo "2. Resource exhaustion (large files, archive bombs)"
echo "3. Content policy violations (NSFW, illegal content)"
echo "4. SSRF via manipulated embed URLs"
echo ""
echo "🔧 Recommended Configuration"
echo "============================"
echo ""
echo "Add to openclaw.json:"
echo ""
cat <<'JSON'
{
  "channels": {
    "discord": {
      "media": {
        "enabled": true,
        "maxSize": 25000000,
        "allowedTypes": [
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "video/mp4",
          "video/webm",
          "audio/mpeg",
          "audio/ogg",
          "application/pdf"
        ],
        "validateMimeType": true,
        "scanMalware": true,
        "checkSizeBeforeDownload": true,
        "validateDiscordCdn": true,
        "rejectExecutables": true,
        "rejectArchives": false
      }
    }
  }
}
JSON

echo ""
echo "🛡️  Security Layers"
echo "=================="
echo ""
echo "1. Type allowlist: Only permit known-safe file types"
echo "2. MIME validation: Check actual file content, not just extension"
echo "3. Size limits: Enforce before downloading to prevent DoS"
echo "4. CDN validation: Only accept Discord's official CDN URLs"
echo "5. Malware scanning: Integrate ClamAV or VirusTotal API"
echo ""
echo "📝 Additional Protections"
echo "========================="
echo ""
echo "1. Sandboxing: Process media in isolated environment"
echo "   - Use firejail or bubblewrap"
echo "   - Restrict network access during processing"
echo ""
echo "2. Rate limiting: Limit media attachments per user"
echo '   {"channels": {"discord": {"rateLimit": {"media": {"maxPerMinute": 10}}}}}'
echo ""
echo "3. Logging: Track all media downloads for audit"
echo '   {"channels": {"discord": {"media": {"logDownloads": true}}}}'
echo ""
echo "4. User restrictions: Limit media by role/permission"
echo '   {"channels": {"discord": {"media": {"requireRole": "verified"}}}}'
echo ""
echo "🧪 Testing Media Validation"
echo "==========================="
echo ""
echo "Test your configuration:"
echo ""
echo "1. Send image with .jpg extension but .exe content"
echo "   Expected: Rejected (MIME mismatch)"
echo ""
echo "2. Send file >25MB"
echo "   Expected: Rejected before download"
echo ""
echo "3. Send Discord message with external embed URL"
echo "   Expected: Rejected (non-Discord CDN)"
echo ""
echo "4. Send .exe file renamed to .jpg"
echo "   Expected: Rejected (MIME validation)"
echo ""
echo "📚 Related Documentation"
echo "========================"
echo ""
echo "- Discord Integration: docs/channels/discord.md"
echo "- Security Hardening: docs/troubleshooting/security-hardening.md"
echo "- Media Handling: docs/channels/media-handling.md"
echo ""
echo "Related: Issue #20906 - Discord media bypass validation"
echo ""
