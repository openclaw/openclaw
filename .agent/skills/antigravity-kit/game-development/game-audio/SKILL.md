---
name: game-audio
description: Game audio principles. Sound design, music integration, adaptive audio systems.
allowed-tools: Read, Glob, Grep
---

# Game Audio Principles

> Sound design and music integration for immersive game experiences.

---

## 1. Audio Category System

### Category Definitions

| Category | Behavior | Examples |
|----------|----------|----------|
| **Music** | Looping, crossfade, ducking | BGM, combat music |
| **SFX** | One-shot, 3D positioned | Footsteps, impacts |
| **Ambient** | Looping, background layer | Wind, crowd, forest |
| **UI** | Immediate, non-3D | Button clicks, notifications |
| **Voice** | Priority, ducking trigger | Dialogue, announcer |

### Priority Hierarchy

```
When sounds compete for channels:

1. Voice (highest - always audible)
2. Player SFX (feedback critical)
3. Enemy SFX (gameplay important)
4. Music (mood, but duckable)
5. Ambient (lowest - can drop)
```

---

## 2. Sound Design Decisions

### SFX Creation Approach

| Approach | When to Use | Trade-offs |
|----------|-------------|------------|
| **Recording** | Realistic needs | High quality, time intensive |
| **Synthesis** | Sci-fi, retro, UI | Unique, requires skill |
| **Library samples** | Fast production | Common sounds, licensing |
| **Layering** | Complex sounds | Best results, more work |

### Layering Structure

| Layer | Purpose | Example: Gunshot |
|-------|---------|------------------|
| **Attack** | Initial transient | Click, snap |
| **Body** | Main character | Boom, blast |
| **Tail** | Decay, room | Reverb, echo |
| **Sweetener** | Special sauce | Shell casing, mechanical |

---

## 3. Music Integration

### Music State System

```
Game State → Music Response
│
├── Menu → Calm, loopable theme
├── Exploration → Ambient, atmospheric
├── Combat detected → Transition to tension
├── Combat engaged → Full battle music
├── Victory → Stinger + calm transition
├── Defeat → Somber stinger
└── Boss → Unique, multi-phase track
```

### Transition Techniques

| Technique | Use When | Feel |
|-----------|----------|------|
| **Crossfade** | Smooth mood shift | Gradual |
| **Stinger** | Immediate event | Dramatic |
| **Stem mixing** | Dynamic intensity | Seamless |
| **Beat-synced** | Rhythmic gameplay | Musical |
| **Queue point** | Next natural break | Clean |

---

## 4. Adaptive Audio Decisions

### Intensity Parameters

| Parameter | Affects | Example |
|-----------|---------|---------|
| **Threat level** | Music intensity | Enemy count |
| **Health** | Filter, reverb | Low health = muffled |
| **Speed** | Tempo, energy | Racing speed |
| **Environment** | Reverb, EQ | Cave vs outdoor |
| **Time of day** | Mood, volume | Night = quieter |

### Vertical vs Horizontal

| System | What Changes | Best For |
|--------|--------------|----------|
| **Vertical (layers)** | Add/remove instrument layers | Intensity scaling |
| **Horizontal (segments)** | Different music sections | State changes |
| **Combined** | Both | AAA adaptive scores |

---

## 5. 3D Audio Decisions

### Spatialization

| Element | 3D Positioned? | Reason |
|---------|----------------|--------|
| Player footsteps | No (or subtle) | Always audible |
| Enemy footsteps | Yes | Directional awareness |
| Gunfire | Yes | Combat awareness |
| Music | No | Mood, non-diegetic |
| Ambient zone | Yes (area) | Environmental |
| UI sounds | No | Interface feedback |

### Distance Behavior

| Distance | Sound Behavior |
|----------|----------------|
| **Near** | Full volume, full frequency |
| **Medium** | Volume falloff, high-freq rolloff |
| **Far** | Low volume, low-pass filter |
| **Max** | Silent or ambient hint |

---

## 6. Platform Considerations

### Format Selection

| Platform | Recommended Format | Reason |
|----------|-------------------|--------|
| PC | OGG Vorbis, WAV | Quality, no licensing |
| Console | Platform-specific | Certification |
| Mobile | MP3, AAC | Size, compatibility |
| Web | WebM/Opus, MP3 fallback | Browser support |

### Memory Budget

| Game Type | Audio Budget | Strategy |
|-----------|--------------|----------|
| Mobile casual | 10-50 MB | Compressed, fewer variants |
| PC indie | 100-500 MB | Quality focus |
| AAA | 1+ GB | Full quality, many variants |

---

## 7. Mix Hierarchy

### Volume Balance Reference

| Category | Relative Level | Notes |
|----------|----------------|-------|
| **Voice** | 0 dB (reference) | Always clear |
| **Player SFX** | -3 to -6 dB | Prominent but not harsh |
| **Music** | -6 to -12 dB | Foundation, ducks for voice |
| **Enemy SFX** | -6 to -9 dB | Important but not dominant |
| **Ambient** | -12 to -18 dB | Subtle background |

### Ducking Rules

| When | Duck What | Amount |
|------|-----------|--------|
| Voice plays | Music, Ambient | -6 to -9 dB |
| Explosion | All except explosion | Brief duck |
| Menu open | Gameplay audio | -3 to -6 dB |

---

## 8. Anti-Patterns

| Don't | Do |
|-------|-----|
| Play same sound repeatedly | Use variations (3-5 per sound) |
| Max volume everything | Use proper mix hierarchy |
| Ignore silence | Silence creates contrast |
| One music track loops forever | Provide variety, transitions |
| Skip audio in prototype | Placeholder audio matters |

---

> **Remember:** 50% of the game experience is audio. A muted game loses half its soul.
