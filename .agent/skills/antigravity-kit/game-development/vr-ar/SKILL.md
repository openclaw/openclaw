---
name: vr-ar
description: VR/AR development principles. Comfort, interaction, performance requirements.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# VR/AR Development

> Immersive experience principles.

---

## 1. Platform Selection

### VR Platforms

| Platform | Use Case |
|----------|----------|
| **Quest** | Standalone, wireless |
| **PCVR** | High fidelity |
| **PSVR** | Console market |
| **WebXR** | Browser-based |

### AR Platforms

| Platform | Use Case |
|----------|----------|
| **ARKit** | iOS devices |
| **ARCore** | Android devices |
| **WebXR** | Browser AR |
| **HoloLens** | Enterprise |

---

## 2. Comfort Principles

### Motion Sickness Prevention

| Cause | Solution |
|-------|----------|
| **Locomotion** | Teleport, snap turn |
| **Low FPS** | Maintain 90 FPS |
| **Camera shake** | Avoid or minimize |
| **Rapid acceleration** | Gradual movement |

### Comfort Settings

- Vignette during movement
- Snap vs smooth turning
- Seated vs standing modes
- Height calibration

---

## 3. Performance Requirements

### Target Metrics

| Platform | FPS | Resolution |
|----------|-----|------------|
| Quest 2 | 72-90 | 1832x1920 |
| Quest 3 | 90-120 | 2064x2208 |
| PCVR | 90 | 2160x2160+ |
| PSVR2 | 90-120 | 2000x2040 |

### Frame Budget

- VR requires consistent frame times
- Single dropped frame = visible judder
- 90 FPS = 11.11ms budget

---

## 4. Interaction Principles

### Controller Interaction

| Type | Use |
|------|-----|
| **Point + click** | UI, distant objects |
| **Grab** | Manipulation |
| **Gesture** | Magic, special actions |
| **Physical** | Throwing, swinging |

### Hand Tracking

- More immersive but less precise
- Good for: social, casual
- Challenging for: action, precision

---

## 5. Spatial Design

### World Scale

- 1 unit = 1 meter (critical)
- Objects must feel right size
- Test with real measurements

### Depth Cues

| Cue | Importance |
|-----|------------|
| Stereo | Primary depth |
| Motion parallax | Secondary |
| Shadows | Grounding |
| Occlusion | Layering |

---

## 6. Anti-Patterns

| ❌ Don't | ✅ Do |
|----------|-------|
| Move camera without player | Player controls camera |
| Drop below 90 FPS | Maintain frame rate |
| Use tiny UI text | Large, readable text |
| Ignore arm length | Scale to player reach |

---

> **Remember:** Comfort is not optional. Sick players don't play.
