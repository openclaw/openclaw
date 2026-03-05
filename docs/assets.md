# Assets Guide

How to organize and reference static assets in apps.

## Folders

Each app serves files from `public/`.

Suggested layout:

```
public/
  assets/
    images/  # PNG/JPG/SVG
    audio/   # MP3/WAV/WEBM
    video/   # MP4/WEBM
    fonts/   # WOFF/TTF (use @font-face + staticFile)
    css/     # Optional CSS
    data/    # JSON, etc.
    lottie/  # Lottie JSON
```

## Referencing

- Image: `/assets/images/logo.png`
- Audio: `/assets/audio/bgm.mp3`
- Video: `/assets/video/clip.mp4`

Lyrics (LRC): place next to the audio file with the same basename.

```ts
const lrc = await fetch("/assets/audio/song.lrc").then((r) => r.text());
```

## Tips

- For large binaries, consider Git LFS or external storage/CDN.
- Some libraries require CSS imports, e.g. `import 'your-lib/dist/styles.css'`.
