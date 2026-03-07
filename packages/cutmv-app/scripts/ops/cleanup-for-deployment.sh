#!/bin/bash

echo "Cleaning up files for deployment..."

# Remove large asset folders
rm -rf attached_assets/
echo "Removed attached_assets folder"

# Clean up uploads directory
rm -rf uploads/chunks/
rm -rf uploads/clips/
echo "Removed uploads/chunks and uploads/clips"

# Remove video files from uploads
find uploads/ -name "*.mp4" -delete 2>/dev/null || true
find uploads/ -name "*.mov" -delete 2>/dev/null || true
find uploads/ -name "*.avi" -delete 2>/dev/null || true
echo "Removed video files from uploads"

# Remove log files
find . -name "*.log" -delete 2>/dev/null || true
echo "Removed log files"

# Remove temporary files
find . -name "*.tmp" -delete 2>/dev/null || true
find . -name "*.temp" -delete 2>/dev/null || true
echo "Removed temporary files"

echo "Cleanup complete!"
echo "Project size after cleanup:"
du -sh . 2>/dev/null || echo "Could not calculate size"