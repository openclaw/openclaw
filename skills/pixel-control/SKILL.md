---
name: pixel-control
description: "Pixel device control via tmux and MCP. Send commands to Android Pixel Termux session, monitor status, and execute remote operations."
metadata: {"moltbot":{"emoji":"📱","requires":{"bins":["tmux","ssh"]},"os":["darwin","linux"]}}
---

# Pixel Control Skill

Control Android Pixel device via Termux SSH connection using tmux integration. Execute commands, monitor status, and manage remote operations.

## Quick Start

### Check SSH Connection

```bash
# Verify SSH connection from Pixel
echo $SSH_CLIENT      # Shows: 100.120.173.54 59458 22
echo $SSH_CONNECTION  # Shows: 100.120.173.54 59458 100.119.37.127 22
```

### Send Commands to Pixel

```bash
# Using tmux (if Pixel has tmux session)
tmux send-keys -t pixel:0.0 "command" Enter

# Via SSH
ssh pixel@pixel-ip "command"
```

## Termux on Pixel

### Basic Operations

```bash
# On Pixel (via SSH or Termux)
pkg install tmux      # Install tmux
pkg install python    # Install Python
pkg install nodejs    # Install Node.js
```

### Environment Variables

```bash
# Load on Pixel Termux
# ~/.zshrc or ~/.bashrc
export PATH="$PATH:$HOME/bin"
```

## Tmux Integration

### Create Pixel Session (on macOS)

```bash
# Create session for Pixel commands
SOCKET="${TMPDIR:-/tmp}/pixel.sock"
tmux -S "$SOCKET" new-session -d -s pixel -n shell

# SSH into Pixel in the session
tmux -S "$SOCKET" send-keys -t pixel:0.0 "ssh pixel@pixel-ip" Enter
```

### Send Commands

```bash
# Send command to Pixel session
tmux -S "$SOCKET" send-keys -t pixel:0.0 "pkg update" Enter
tmux -S "$SOCKET" send-keys -t pixel:0.0 "termux-microphone-record" Enter

# Capture output
tmux -S "$SOCKET" capture-pane -p -t pixel:0.0 -S -50
```

## File Transfer

### From Pixel to Mac

```bash
# On Mac, pull file from Pixel
scp pixel@pixel-ip:/path/on/pixel/file.txt ~/Downloads/

# Push file to Pixel
scp ~/local-file.txt pixel@pixel-ip:/path/on/pixel/
```

### Voicebox Audio Transfer

```bash
# Copy generated audio to Pixel
scp ~/voicebox/latest.wav pixel@pixel-ip:~/Downloads/voice.wav

# Play on Pixel
ssh pixel@pixel-ip "termux-media-player play ~/Downloads/voice.wav"
```

## Android-Specific Operations

### Media Control

```bash
# Via SSH
ssh pixel@pixel-ip "termux-media-player play /path/to/audio.mp3"
ssh pixel@pixel-ip "termux-media-player pause"

# Volume control
ssh pixel@pixel-ip "termux-volume music 50"
```

### Notifications

```bash
# Send notification to Pixel
ssh pixel@pixel-ip "termux-notification -t 'Title' -c 'Content'"
```

### Camera

```bash
# Take photo
ssh pixel@pixel-ip "termux-camera-photo ~/Downloads/photo.jpg"

# Record video
ssh pixel@pixel-ip "termux-camera-record ~/Downloads/video.mp4"
```

## Status Monitoring

### Check Pixel Status

```bash
# Check if Pixel is reachable
ping -c 1 pixel-ip

# Check SSH connection
ssh pixel@pixel-ip "echo 'Connected'"

# Check battery
ssh pixel@pixel-ip "termux-battery-status"

# Check system info
ssh pixel@pixel-ip "uname -a"
```

### Tmux Session Status

```bash
# List Pixel-related sessions
tmux list-sessions | grep pixel

# Check session activity
tmux -S "$SOCKET" capture-pane -p -t pixel:0.0 -S -5
```

## Common Workflows

### Voice Output on Pixel

```bash
# 1. Generate audio on Mac
~/.local/bin/voicebox.sh "ピクセルで読み上げ"

# 2. Transfer to Pixel
scp ~/voicebox/latest.wav pixel@pixel-ip:~/Downloads/voice.wav

# 3. Play on Pixel
ssh pixel@pixel-ip "termux-media-player play ~/Downloads/voice.wav"
```

### Remote Development

```bash
# Run Node.js script on Pixel
scp script.js pixel@pixel-ip:~/Dev/
ssh pixel@pixel-ip "node ~/Dev/script.js"

# Run Python script
ssh pixel@pixel-ip "python ~/Dev/script.py"
```

## Emergency Recovery

### If Pixel loses connection

```bash
# Check connectivity
ping pixel-ip

# Restart SSH on Pixel (requires physical access)
# Settings > Apps > Termux > Termux:BOOT

# Clear tmux session if needed
tmux -S "$SOCKET" kill-session -t pixel
```

## Notes

- Pixel IP may change (use static IP or hostname)
- SSH keys required for passwordless login
- Termux API packages needed for system features
- Audio files must be transferred before playback
- tmux sessions persist after SSH disconnect
