# visionOS Node

A native visionOS companion app that pairs with the OpenClaw Gateway as a peripheral node,
giving the AI agent spatial awareness, hand tracking, world sensing, and GPS from an
Apple Vision Pro.

Built by [LOAM STUDIO](https://loamstudio.com).

---

## Overview

The visionOS node connects to your OpenClaw Gateway over WebSocket and exposes the Vision
Pro's sensor suite as invokable commands. Once paired, your agent can ask "where are the
user's hands?" or "what flat surfaces are in the room?" and receive live spatial data back
in structured JSON.

**What it gives your agent:**

| Command | Capability |
|---|---|
| `spatial.hands` | Full 26-joint skeletal hand tracking (both hands) |
| `spatial.planes` | Detected flat surfaces — floors, walls, tables, seats, doors, windows |
| `spatial.mesh` | Full scene reconstruction as triangulated 3D geometry |
| `device.position` | Head position and orientation as a 4×4 world-space transform |
| `device.info` | Device identifiers and node version |
| `location.get` | GPS coordinates via CoreLocation |
| `camera.snap` | Still frame from main camera _(requires Apple Enterprise entitlement)_ |
| `camera.clip` | Short video clip from main camera _(requires Apple Enterprise entitlement)_ |

---

## Requirements

- Apple Vision Pro (visionOS 2.0+)
- OpenClaw Gateway running on a reachable host (local network or Tailscale)
- Xcode 16+ for building
- For `camera.*` commands: Apple Developer Enterprise Program enrollment +
  `com.apple.developer.arkit.main-camera-access.allow` entitlement

---

## Setup

### 1. Clone and open in Xcode

```bash
git clone https://github.com/LOAM-STUDIO/visionOS-node.git
cd visionOS-node
open visionOS-node/visionOS-node.xcodeproj
```

### 2. Configure signing

In Xcode → **Signing & Capabilities**, set your team and bundle identifier.
The app requires a physical Vision Pro — the simulator does not support ARKit providers.

### 3. Build and run on device

Select your Vision Pro in the device list, then **Product → Run** (⌘R).

### 4. Enter your Gateway URL and auth token

On first launch, tap the **Settings** (gear) icon and enter:

- **Gateway URL** — your gateway's address, e.g. `your-gateway-host.ts.net` or a local
  IP like `192.168.1.100` (the `wss://` prefix is added automatically)
- **Auth token** — the token from your `openclaw.json` config

### 5. Approve the node on your Gateway

When the node first connects, it enters `Awaiting Gateway Approval` state. On your
Gateway host, run:

```bash
openclaw devices list
openclaw devices approve <node-id>
```

Once approved, the node status shows **Connected** and your agent can invoke commands.

### 6. Allow the ImmersiveSpace

To enable spatial commands (`spatial.hands`, `spatial.planes`, `spatial.mesh`,
`device.position`), tap **Enter Immersive Space** from the main screen. This opens a
minimal mixed-reality space required for ARKit to run. You will be prompted to allow
**Hand Tracking** and **World Sensing** permissions — both must be granted.

> **Note:** ARKit providers require an active ImmersiveSpace. If you close the immersive
> space, spatial commands return `arkit-not-running`. `device.position`, `location.get`,
> and `device.info` continue to work without the space open.

---

## Gateway Configuration

Add the visionOS commands to your gateway's `allowCommands` list in `~/.openclaw/openclaw.json`:

```json
{
  "allowCommands": [
    "camera.snap",
    "camera.clip",
    "spatial.planes",
    "spatial.hands",
    "spatial.mesh",
    "device.position",
    "location.get"
  ]
}
```

---

## Commands Reference

All commands follow the standard OpenClaw `node.invoke` pattern. The gateway sends a
`node.invoke.request` event to the node; the node replies with a `node.invoke.result`
request.

---

### `spatial.hands`

Returns a snapshot of both hands' current pose with full 26-joint skeletal data.

**Requires:** Active ImmersiveSpace · Hand Tracking permission

**Response payload:**

```json
{
  "left": {
    "chirality": "left",
    "isTracked": true,
    "originTransform": [/* 16-element column-major float array */],
    "joints": {
      "wrist": { "transform": [/* 16 floats */], "isTracked": true },
      "thumbTip": { "transform": [/* 16 floats */], "isTracked": true },
      "indexFingerTip": { "transform": [/* 16 floats */], "isTracked": true }
      // … all 26 joints
    }
  },
  "right": { /* same structure */ },
  "timestamp": 1743120000.0
}
```

**All 26 joints per hand:**
`wrist`, `thumbKnuckle`, `thumbIntermediateBase`, `thumbIntermediateTip`, `thumbTip`,
`indexFingerMetacarpal`, `indexFingerKnuckle`, `indexFingerIntermediateBase`,
`indexFingerIntermediateTip`, `indexFingerTip`, `middleFingerMetacarpal`,
`middleFingerKnuckle`, `middleFingerIntermediateBase`, `middleFingerIntermediateTip`,
`middleFingerTip`, `ringFingerMetacarpal`, `ringFingerKnuckle`,
`ringFingerIntermediateBase`, `ringFingerIntermediateTip`, `ringFingerTip`,
`littleFingerMetacarpal`, `littleFingerKnuckle`, `littleFingerIntermediateBase`,
`littleFingerIntermediateTip`, `littleFingerTip`, `forearmWrist`

**Transforms** are column-major 4×4 matrices encoded as 16-element float arrays.

---

### `spatial.planes`

Returns all currently detected flat surfaces in the scene.

**Requires:** Active ImmersiveSpace · World Sensing permission

**Response payload:**

```json
{
  "planes": [
    {
      "id": "A1B2C3D4-…",
      "alignment": "horizontal",
      "classification": "floor",
      "center": [0.0, 0.0, -1.5],
      "extent": [2.4, 1.8],
      "transform": [/* 16 floats */],
      "timestamp": 1743120000.0
    }
  ],
  "count": 12
}
```

**`alignment`:** `horizontal` | `vertical` | `arbitrary`

**`classification`:** `floor` | `wall` | `ceiling` | `table` | `seat` | `door` | `window`

---

### `spatial.mesh`

Returns the full scene reconstruction as a set of mesh chunks (triangulated geometry).

**Requires:** Active ImmersiveSpace · World Sensing permission

> **Note:** This command returns large payloads. A typical room scan produces 10–20 chunks
> with thousands of faces each. Plan for response sizes in the hundreds of KB.

**Response payload:**

```json
{
  "chunks": [
    {
      "id": "A1B2C3D4-…",
      "transform": [/* 16 floats */],
      "vertexCount": 1240,
      "faceCount": 890,
      "vertices": [[x, y, z], …],
      "faces": [[v0, v1, v2], …],
      "timestamp": 1743120000.0
    }
  ],
  "count": 14
}
```

---

### `device.position`

Returns the current head position and orientation in world space.

**Requires:** Active ImmersiveSpace (WorldTrackingProvider)

**Response payload:**

```json
{
  "transform": [/* 16-element column-major float array */],
  "timestamp": 1743120000.0
}
```

The transform encodes the full 6DoF head pose. Extract position from `columns[3]` (x, y, z).

---

### `device.info`

Returns device and node metadata. Does not require an ImmersiveSpace.

**Response payload:**

```json
{
  "platform": "visionos",
  "modelIdentifier": "RealityDevice14,1",
  "nodeVersion": "0.1.0",
  "deviceID": "be1289e6…"
}
```

---

### `location.get`

Returns the device's GPS location via CoreLocation.

**Requires:** Location permission (`NSLocationWhenInUseUsageDescription`)

Does **not** require an active ImmersiveSpace.

**Response payload:**

```json
{
  "latitude": 37.7749,
  "longitude": -122.4194,
  "altitude": 15.2,
  "horizontalAccuracy": 19.0,
  "verticalAccuracy": 5.0,
  "timestamp": 1743120000.0
}
```

---

### `camera.snap` / `camera.clip`

Capture a still image or short video clip from the Vision Pro's main forward-facing camera.

**⚠️ Enterprise entitlement required**

These commands require the `com.apple.developer.arkit.main-camera-access.allow`
entitlement, which is only available through the Apple Developer Enterprise Program.

Without the entitlement, these commands return:

```json
{ "code": "UNAVAILABLE", "detail": "enterprise-entitlement-required" }
```

When the app is backgrounded (ImmersiveSpace closed), they return:

```json
{ "code": "NODE_BACKGROUND_UNAVAILABLE", "detail": "camera-unavailable-in-background" }
```

---

## Error Codes

| Code | Meaning |
|---|---|
| `UNAVAILABLE` | Command is implemented but a prerequisite is not met (see `detail`) |
| `NODE_BACKGROUND_UNAVAILABLE` | The ImmersiveSpace is closed; camera/canvas commands cannot run |
| `PERMISSION_DENIED` | User denied the required system permission |
| `UNKNOWN_COMMAND` | Command not recognized by this node |
| `FORBIDDEN` | Request rejected due to security policy (parameter injection attempt) |

---

## Architecture

```
Vision Pro
├── visionOS-nodeApp.swift      — App entry point, ImmersiveSpace declaration
├── ContentView.swift           — Main UI; hosts GatewayConfigView + ConnectionStatusView
├── Gateway/
│   ├── GatewaySocket.swift     — URLSessionWebSocketTask, receive loop, frame parsing
│   ├── HandshakeManager.swift  — v3 protocol: Secure Enclave keypair, nonce signing
│   ├── NodeManager.swift       — State machine, RPC dispatcher, command handlers
│   └── LocationManager.swift   — CoreLocation one-shot async wrapper
├── Spatial/
│   └── SpatialManager.swift    — ARKit session: hands, world, planes, mesh
├── Lifecycle/
│   └── ScenePhaseMonitor.swift — Detects background/foreground, sends exit frame
├── Notifications/
│   └── APNsManager.swift       — APNs token registration (future: background wake)
└── Views/
    ├── NodeImmersiveView.swift  — Minimal .mixed ImmersiveSpace (ARKit lifecycle anchor)
    ├── GatewayConfigView.swift  — URL + token settings
    └── ConnectionStatusView.swift — Live connection status display
```

### Connection lifecycle

```
App launch
  └─ ContentView.onAppear → NodeManager.connect()
       └─ GatewaySocket connects (WSS)
            └─ challenge event → HandshakeManager signs nonce → send connect frame
                 └─ hello-ok → NodeManager: state = .connected
                      └─ node.invoke.request events → dispatchCommand() → sendOK/sendError
```

The WebSocket is **app-level**, not ImmersiveSpace-level — the socket stays alive when
the immersive space is closed. ARKit providers are **ImmersiveSpace-level** — they start
when the user opens the space and stop when it closes.

### ImmersiveSpace as lifecycle anchor

visionOS suspends apps and kills WebSockets when the app loses foreground focus without
an active ImmersiveSpace. The `NodeImmersiveView` opens a minimal `.mixed` space solely
to prevent process suspension — it renders nothing visible. This is architecturally
required, not optional UI decoration.

### Protocol

The node uses OpenClaw Gateway Protocol v3:

- **Handshake:** The gateway sends `connect.challenge` as a `type:"event"` frame.
  The node signs the nonce with its Secure Enclave keypair and replies with a
  `type:"req"` connect frame.
- **Commands:** The gateway delivers `node.invoke.request` as a `type:"event"` frame
  with the command and params in the payload.
- **Responses:** The node replies with `type:"req"`, `method:"node.invoke.result"`,
  and params `{ id, nodeId, ok, payload | error }`.

### Security

The node implements CVE-2026-28466 mitigations: any incoming RPC params containing
`approved`, `bypass`, `override`, `authorized`, or `approvalDecision` keys are rejected
outright with `FORBIDDEN`. Approval decisions are gateway-side only and cannot be
smuggled through command parameters.

---

## Info.plist Privacy Keys

The following keys must be present in `Info.plist`:

| Key | Used by |
|---|---|
| `NSHandsTrackingUsageDescription` | `spatial.hands` |
| `NSWorldSensingUsageDescription` | `spatial.planes`, `spatial.mesh`, `device.position` |
| `NSLocationWhenInUseUsageDescription` | `location.get` |

---

## Device Identity & Keychain

The node derives a stable device ID from an Ed25519 keypair stored in Keychain with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. This means:

- The keypair — and therefore the device ID — **persists across app reinstalls and Xcode
  clean builds**. You will not need to re-approve the node after rebuilding.
- The identity is **device-bound** and cannot be transferred or backed up.
- To force a fresh device ID (e.g. to test re-pairing), delete the Keychain item manually:

```swift
// In a debug build, or via a Settings "Reset Node Identity" button:
let query: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: "com.openclaw.node"
]
SecItemDelete(query as CFDictionary)
```

After deleting, the next app launch generates a new keypair and a new device ID, which
will require re-approval on the Gateway.

---

## Known Limitations

- **Camera requires Enterprise entitlement** — `camera.snap` and `camera.clip` are
  implemented but blocked on `com.apple.developer.arkit.main-camera-access.allow`.
  Contact Apple Developer Enterprise support to request this entitlement.
- **Spatial commands require ImmersiveSpace** — ARKit providers cannot run outside an
  active ImmersiveSpace. Design your agent workflows to account for the space being open.
- **`spatial.mesh` payload size** — Full scene reconstructions can be 500KB+. Consider
  requesting mesh only when needed and caching the result client-side.
- **No APNs background wake yet** — The app must be in the foreground (ImmersiveSpace
  open) to receive commands. Background wake via APNs silent push is planned.
- **Canvas (WKWebView) commands not yet implemented** — `canvas.*` commands are stubbed
  and return `UNAVAILABLE`.

---

## Contributing

This node is part of LOAM STUDIO's open source contribution to OpenClaw.
The source lives at [github.com/LOAM-STUDIO/visionOS-node](https://github.com/LOAM-STUDIO/visionOS-node).

Issues, PRs, and feedback welcome.
