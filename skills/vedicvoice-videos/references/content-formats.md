# Content Formats

## 1. Mantra Short (60s vertical)

**Purpose:** Single verse highlight from the VedicVoice library. Drive traffic to vedicvoice.app.
**Tone:** Meditative, reverent, beautiful.
**Composition:** `MantraShort` (exists in Remotion)

### Structure

| Segment          | Duration | Visual                                     | Audio                          |
| ---------------- | -------- | ------------------------------------------ | ------------------------------ |
| Sanskrit display | 20s      | Gold Devanagari text on dark blue, Om glow | Sanskrit chanting (AI4Bharat)  |
| Transliteration  | 10s      | Romanized text, pronunciation guide        | Soft background                |
| Translation      | 20s      | English meaning with book/verse ref        | English narration (ElevenLabs) |
| CTA              | 10s      | Saffron card with vedicvoice.app link      | —                              |

### Image prompts style guide

- Background: dark, cosmic, spiritual (starfield, temple interior, lotus pond)
- No specific deity unless the verse references one
- Color palette: deep blue (#0D1B2A), gold (#FFD700), saffron (#FF9933)

### Example spec (Isha Upanishad 1.1)

```json
{
  "type": "mantra-short",
  "title": "Isha Upanishad 1.1",
  "scenes": [
    {
      "name": "sanskrit",
      "duration": 20,
      "sanskrit_text": "ईशावास्यमिदं सर्वं यत्किञ्च जगत्यां जगत्",
      "transliteration": "īśāvāsyam idaṁ sarvaṁ yat kiñca jagatyāṁ jagat",
      "sanskrit_audio": "ai4bharat:chanting",
      "image_prompt": "Cosmic night sky with golden Sanskrit Om symbol radiating divine light, dark blue ethereal atmosphere, sacred geometry patterns, vertical format, spiritual meditation scene",
      "image_model": "imagen4"
    },
    {
      "name": "transliteration",
      "duration": 10,
      "text_overlay": "īśāvāsyam idaṁ sarvaṁ\nyat kiñca jagatyāṁ jagat"
    },
    {
      "name": "translation",
      "duration": 20,
      "narration": "All this, whatever exists in this changing universe, should be covered by the Lord.",
      "narration_voice": "elevenlabs:george",
      "image_prompt": "Vast universe with Earth seen from space, golden divine light enveloping the planet, stars and galaxies, spiritual cosmic art, vertical format",
      "image_model": "flux-2-pro"
    },
    {
      "name": "cta",
      "duration": 10,
      "text_overlay": "Listen to the full Isha Upanishad\nvedicvoice.app/library"
    }
  ]
}
```

---

## 2. Bal Gita Kids (60s vertical)

**Purpose:** Teach Bhagavad Gita concepts to children 5-10 years old. Fun, colorful, memorable.
**Tone:** Warm, playful, encouraging. Like a favourite teacher.
**Composition:** Custom (extend `StoryShort` or create new)

### Structure

| Segment         | Duration | Visual                          | Audio                       |
| --------------- | -------- | ------------------------------- | --------------------------- |
| Hook question   | 5s       | Eye-catching illustrated scene  | Warm narrator asks question |
| Story setup     | 15s      | Illustrated scene(s)            | Narrator tells the story    |
| Krishna teaches | 20s      | Krishna with child, warm scene  | Narrator explains the verse |
| Sanskrit verse  | 10s      | Devanagari text, illustrated bg | Sanskrit chanting           |
| Lesson/takeaway | 5s       | Kid-friendly moral card         | Narrator sums up            |
| CTA             | 5s       | VedicVoice branding             | —                           |

### Image prompts style guide

- **Art style:** Warm 3D Pixar/Disney-inspired Indian characters OR Amar Chitra Katha illustration
- **Krishna:** Young, playful, blue-skinned, wearing peacock feather, warm smile
- **Arjuna:** Young warrior, determined but approachable
- **Colors:** Bright, saturated — saffron, peacock blue, forest green, golden yellow
- **Backgrounds:** Lush Indian landscapes, palace gardens, battlefield (made gentle)
- **IMPORTANT:** Always include "child-friendly, warm, colorful, Indian mythology illustration" in prompts
- Use `nano-banana-pro` for best kids illustration quality

### Example spec (BG 2.47 — "Just Try Your Best")

```json
{
  "type": "bal-gita",
  "title": "Just Try Your Best - BG 2.47",
  "scenes": [
    {
      "name": "hook",
      "duration": 5,
      "narration": "Have you ever been so worried about winning that you forgot to have fun?",
      "narration_voice": "elevenlabs:nova",
      "image_prompt": "A young Indian boy looking worried at a cricket match, Pixar-style 3D animation, colorful Indian sports ground, child-friendly warm illustration, vertical format",
      "image_model": "nano-banana-pro"
    },
    {
      "name": "setup",
      "duration": 15,
      "narration": "Long ago, the great warrior Arjuna stood on a battlefield. He was the best archer in the world, but he was terrified. Not of losing — but of what would happen if he won.",
      "narration_voice": "elevenlabs:nova",
      "image_prompt": "Young warrior Arjuna standing hesitantly on ancient Indian battlefield, Pixar-style 3D Indian mythology, warm golden sunset, elephants and chariots in soft focus background, child-friendly, colorful, vertical format",
      "image_model": "nano-banana-pro"
    },
    {
      "name": "krishna-teaches",
      "duration": 20,
      "narration": "Krishna, his best friend and guide, smiled and said: Your job is to try your very best. That's it! Don't worry about winning or losing. Just give it everything you've got, and whatever happens, you can be proud.",
      "narration_voice": "elevenlabs:nova",
      "image_prompt": "Blue-skinned young Krishna with peacock feather, smiling warmly, talking to young Arjuna on a golden chariot, magical glowing atmosphere, Pixar-style 3D Indian mythology, child-friendly warm colors, vertical format",
      "image_model": "nano-banana-pro"
    },
    {
      "name": "sanskrit",
      "duration": 10,
      "sanskrit_text": "कर्मण्येवाधिकारस्ते मा फलेषु कदाचन",
      "transliteration": "karmaṇy evādhikāras te mā phaleṣu kadācana",
      "sanskrit_audio": "ai4bharat:chanting",
      "image_prompt": "Golden Sanskrit text glowing against deep blue cosmic background with subtle lotus motifs, sacred and beautiful, vertical format",
      "image_model": "imagen4"
    },
    {
      "name": "lesson",
      "duration": 5,
      "narration": "So remember: just try your best, and let the rest take care of itself!",
      "narration_voice": "elevenlabs:nova",
      "text_overlay": "Just try your best! 🌟"
    },
    {
      "name": "cta",
      "duration": 5,
      "text_overlay": "More stories at\nvedicvoice.app\n@VedicVoice"
    }
  ]
}
```

---

## 3. Deep Dive (3-5min, horizontal or vertical)

**Purpose:** In-depth exploration of a text, verse, or concept. Scholarly but accessible.
**Tone:** Documentary style. Thoughtful, reverent, educational.
**Composition:** Custom (multi-segment, longer format)

### Structure

| Segment           | Duration         | Visual                      | Audio                                  |
| ----------------- | ---------------- | --------------------------- | -------------------------------------- |
| Hook/intro        | 15s              | Dramatic scene              | George narrates hook                   |
| Context           | 30-60s           | Historical/cultural imagery | George explains background             |
| Sanskrit verse(s) | 30-60s per verse | Devanagari + background     | Sanskrit chanting + George translation |
| Commentary        | 60-120s          | Illustrated concepts        | George explains meaning                |
| Modern relevance  | 30-60s           | Modern parallels            | George connects to today               |
| CTA               | 10s              | VedicVoice branding         | —                                      |

### Image prompts style guide

- **Art style:** Photorealistic or high-quality digital painting
- **Scenes:** Ancient India (temples, forests, rivers), astronomical, philosophical
- **Colors:** Rich, warm — amber, deep red, forest green, starlight blue
- **Use `flux-2-pro` or `imagen4`** for consistent documentary quality

---

## 4. Story Short (60s vertical)

**Purpose:** Hindu mythological stories (like Ganesha Apple Race). Entertainment + wisdom.
**Tone:** Engaging, dramatic, fun twist at the end.
**Composition:** `StoryShort` / `GaneshaAppleRace` (exists in Remotion)

### Structure

| Segment       | Duration | Visual                 | Audio                        |
| ------------- | -------- | ---------------------- | ---------------------------- |
| Hook question | 5s       | Dramatic scene         | Narrator hooks with question |
| Story scenes  | 35-40s   | 3-4 illustrated scenes | Narrator tells story         |
| Moral/twist   | 10s      | Glowing wisdom card    | Narrator reveals meaning     |
| CTA           | 5s       | VedicVoice branding    | —                            |

### Image prompts style guide

- Match Bal Gita style for kids stories
- Match Deep Dive style for mature stories
- Always generate hook + moral as separate dramatic images
