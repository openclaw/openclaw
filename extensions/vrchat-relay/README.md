# VRChat Relay Extension (Pro Edition)

VRChat integration plugin for OpenClaw with OSC protocol support. This is the **Pro Edition** featuring advanced camera control, permission management, rate limiting, and OSCQuery discovery.

## Features

### Basic Features

- **OSC Communication**: Send and receive OSC messages to/from VRChat
- **Chatbox Control**: Send messages with typing animation and notification sounds
- **Avatar Parameters**: Control avatar parameters (bool/int/float)
- **Input Commands**: Send VRChat input commands (Jump, Move, Look, etc.)
- **OSC Listener**: Receive OSC messages from VRChat
- **Authentication**: VRChat API authentication with 2FA/TOTP support

### Pro Features

- **Camera Control**: Full control over VRChat camera (Zoom, Aperture, Focal Distance, etc.)
- **GreenScreen HSL**: Chroma key color adjustment
- **LookAtMe Composition**: Camera framing with offsets
- **Permission Profiles**: SAFE/PRO/DIRECTOR permission levels
- **Rate Limiting**: Token bucket algorithm (5 msg/5 sec for chat)
- **OSCQuery Discovery**: Automatic avatar parameter discovery
- **Audit Logging**: Full operation logging for safety

## Installation

```bash
cd extensions/vrchat-relay
npm install
```

## Configuration

Add to your OpenClaw configuration:

```json
{
  "vrchat-relay": {
    "osc": {
      "outgoingPort": 9000,
      "incomingPort": 9001,
      "host": "127.0.0.1"
    },
    "security": {
      "defaultPermissionLevel": "SAFE"
    }
  }
}
```

## Permission Levels

### SAFE (Default)

- Chatbox messaging
- Avatar parameter control
- OSC listener
- Discovery

### PRO

- SAFE + Input commands
- Jump, Move, Interact controls

### DIRECTOR

- SAFE + Camera control
- Zoom, Aperture, Focus
- GreenScreen HSL
- LookAtMe offsets
- Camera capture

## Available Tools

### Authentication

- `vrchat_login` - Authenticate with VRChat
- `vrchat_logout` - Logout and clear session
- `vrchat_status` - Check status

### Permission Management

- `vrchat_permission_set` - Change permission level
- `vrchat_permission_status` - View current permissions

### Chatbox

- `vrchat_chatbox` - Send message with typing animation
- `vrchat_typing` - Set typing indicator

### Avatar

- `vrchat_set_avatar_param` - Set avatar parameter
- `vrchat_discover` - Discover avatar parameters via OSCQuery
- `vrchat_send_osc` - Send raw OSC message

### Input (PRO)

- `vrchat_input` - Send input command

### Camera (DIRECTOR)

- `vrchat_camera_set` - Set camera parameter
- `vrchat_camera_greenscreen` - Set GreenScreen HSL
- `vrchat_camera_lookatme` - Set LookAtMe composition
- `vrchat_camera_capture` - Trigger camera capture

### OSC Listener

- `vrchat_start_listener` - Start OSC listener
- `vrchat_stop_listener` - Stop OSC listener
- `vrchat_listener_status` - Get listener status

### Audit & Safety

- `vrchat_audit_logs` - View operation logs
- `vrchat_reset_rate_limits` - Reset rate limiters

## Camera Parameters

Official VRChat 2025.3.3 Open Beta ranges:

| Parameter         | Range     | Type     |
| ----------------- | --------- | -------- |
| Zoom              | 20 - 150  | FOV mm   |
| Aperture          | 1.4 - 32  | F-stop   |
| FocalDistance     | 0 - 10    | meters   |
| Exposure          | 0 - 10    | EV       |
| PhotoRate         | 0.1 - 2.0 | sec      |
| Duration          | 0.1 - 60  | sec      |
| FlySpeed          | 0.1 - 15  | speed    |
| TurnSpeed         | 0.1 - 5   | speed    |
| SmoothingStrength | 0.1 - 10  | strength |
| Hue               | 0 - 360   | degrees  |
| Saturation        | 0 - 100   | %        |
| Lightness         | 0 - 50    | %        |
| LookAtMeXOffset   | -25 - 25  | units    |
| LookAtMeYOffset   | -25 - 25  | units    |

## Usage Examples

### Send Chatbox Message with Typing

```bash
openclaw agent --message "Send 'Hello VRChat!' to chatbox with typing animation"
```

### Set Camera Zoom

```bash
openclaw agent --message "Set VRChat camera zoom to 50 (requires DIRECTOR permission)"
```

### Change Permission Level

```bash
openclaw agent --message "Switch to DIRECTOR mode for camera control"
```

### Discover Avatar Parameters

```bash
openclaw agent --message "Discover OSC parameters for current avatar"
```

## Rate Limits

- **Chatbox**: 5 messages / 5 seconds (30s jail on violation)
- **Input**: 20 commands / second
- **Camera**: 10 commands / second

## Safety Features

1. **Permission System**: Operations blocked based on permission level
2. **Rate Limiting**: Token bucket algorithm prevents spam
3. **Value Clamping**: Camera values automatically clamped to valid ranges
4. **Audit Logging**: All operations logged for debugging
5. **127.0.0.1 Only**: OSC communication restricted to localhost

## File Structure

```
extensions/vrchat-relay/
├── index.ts                      # Plugin entry point
├── package.json                  # Dependencies
├── openclaw.plugin.json          # Plugin metadata
├── README.md                     # This file
└── src/
    ├── osc/
    │   ├── types.ts              # OSC type definitions
    │   ├── codec.ts              # OSC encoder/decoder
    │   ├── client.ts             # OSC client
    │   └── camera.ts             # Camera parameter definitions
    ├── auth/
    │   ├── types.ts              # Authentication types
    │   └── index.ts              # VRChat API auth
    └── tools/
        ├── chatbox.ts            # Basic chatbox
        ├── chatbox-enhanced.ts   # Enhanced chatbox with typing
        ├── avatar.ts             # Avatar parameters
        ├── input.ts              # Input commands
        ├── listener.ts           # OSC listener
        ├── camera.ts             # Camera control
        ├── permissions.ts        # Permission management
        ├── rate-limiter.ts       # Token bucket rate limiting
        ├── discovery.ts          # OSCQuery discovery
        └── audit.ts              # Audit logging
```

## References

- [VRChat OSC Documentation](https://docs.vrchat.com/docs/osc-overview)
- [VRChat Camera OSC (2025.3.3)](https://docs.vrchat.com/docs/vrchat-202533-openbeta)
- [OSCQuery Protocol](https://github.com/vrchat-community/vrc-oscquery-lib)

## License

MIT
