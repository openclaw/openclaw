# Full Digital — Motion Dataset

## Naming Convention
<brand>__motion__<template>__<platform>__<WxH>__dur-<sec>__v###.mp4

Examples:
- fulldigital__motion__hook-metrics__reels__1080x1920__dur-12__v004.mp4
- fulldigital__motion__cta-reveal__igfeed__1080x1350__dur-8__v001.mp4

## Structure
- remotion_projects/ — Source Remotion projects (src/ + public/ per project)
- renders/ — Final rendered outputs (mp4/, mov/, gif/)
- frames/keyframes/ — Extracted keyframes at fixed intervals
- annotations/motion_specs/ — JSON motion specs per render
- annotations/transcripts/ — Voiceover transcripts (if applicable)
- annotations/timings/ — Beat markers, CTA timing, transition points
