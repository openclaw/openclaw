# Cloud Vocal Brief

Project: 2026-05-14-validation-happy-path
Source: garageband-source-validation
Vocal plan: blocked-tupac-voice-test

## Direction

voice that sounds exactly like Tupac rapping over the beat

## Rights and Safety

- Use original lyrics and original vocal identity only.
- Do not imitate a living artist or clone a real person without written permission.
- Do not use copyrighted lyrics, uncleared samples, or protected melodies.
- Keep model/tool rights evidence for any cloud service used.

## Lyrics

Original words only

## Delivery

Export the vocal or vocal-forward result as WAV, AIFF, MP3, or M4A. Then run:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs vocal-ingest --project 2026-05-14-validation-happy-path --plan blocked-tupac-voice-test --file <vocal-audio>
node music-creator-v1/scripts/music-creator-v1.mjs bridge-export --project 2026-05-14-validation-happy-path --vocal <vocal-id>
```
