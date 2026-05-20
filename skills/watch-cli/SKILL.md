---
name: watch-cli
description: "Watch any social video → get an architecture diagram, working component, runnable notebook, or step-by-step cheat sheet — automatically."
homepage: https://github.com/sonpiaz/watch-cli
metadata:
  openclaw:
    emoji: ""
    requires:
      bins:
        - watch
    install:
      - id: curl-install
        kind: shell
        command: "curl -fsSL https://raw.githubusercontent.com/sonpiaz/watch-cli/main/install.sh | bash"
        bins:
          - watch
        label: "Install watch-cli (curl)"
---

Watch any social video → get an architecture diagram, working component, runnable notebook, or step-by-step cheat sheet — automatically.

watch-cli is a thin orchestrator that downloads any social video, extracts evenly-spaced frames, and transcribes the audio. The output is a single labeled block (or one-line JSON) designed for an LLM to read frames as images and transcript as text. The agent supplies the prompt; watch-cli supplies the raw materials.

## When to invoke

Reach for `watch` whenever the user gives you a video URL and wants you to do something with what's in it.

- The user pastes a video URL with no verb. Ask one clarifying question ("summarize, implement, clone the UI, extract the architecture, or something else?"), then run `watch`.
- The user asks to "summarize", "explain", or "walk me through" content at a video URL.
- The user asks to "implement", "clone", "build", or "replicate" what is on screen in a video.
- The user asks to "extract architecture from", "diagram", or "turn this paper talk into code" at a video URL.

Supported platforms: YouTube, X / Twitter, LinkedIn, TikTok, Vimeo, Reddit, Facebook. Login-walled sources fall back to the user's signed-in browser cookies automatically.

## What you get back

The `watch` output gives you the raw materials to map to five concrete artifacts. Match the user's intent to one of them.

A coding walkthrough becomes working project files: read the frames for file names, exact code, and dependencies; read the transcript for intent and rationale; emit the final state, not the intermediate edits.

A system architecture talk becomes an interactive architecture diagram: a single self-contained HTML page with actors, surfaces, APIs, and clickable named flows that highlight the path through the system.

A UI or motion demo becomes a working React component: one paste-ready `.tsx` file that captures the feel and the single interaction that makes the UI special, not a pixel-perfect screenshot.

A paper or research talk becomes a runnable notebook: one `.ipynb` implementing the core method on a toy dataset that runs end-to-end on a free Colab T4.

A long tutorial becomes a step-by-step cheat sheet: numbered steps with copy-pasteable commands, video timestamps, verification per step, and only the troubleshooting the speaker actually discussed.

Five copy-paste prompt templates live in [`prompts/`](https://github.com/sonpiaz/watch-cli/tree/main/prompts). Pick the one that matches the user's intent.

## Parse rules

`watch` emits a versioned, agent-shaped payload. Both formats are documented in [`docs/output-schema.md`](https://github.com/sonpiaz/watch-cli/blob/main/docs/output-schema.md) and conform to the v1 contract — append-only, no renames, no type changes within v1.

- **Preferred: JSON mode.** `watch <url> --format json` emits one UTF-8 JSON object on stdout terminated by a newline. Parse it with a real JSON parser, switch on `obj.version`, read `obj.video_path`, `obj.duration_sec`, `obj.frame_paths` (array of absolute JPG paths, earliest-in-video first), `obj.transcript` (string or `null`), and `obj.exit_code`. Field reference is the single source of truth in `docs/output-schema.md`.
- **Fallback: text mode.** Some agent hosts (Claude Code does this today) capture stdout as a free-text block. The leading line `WATCH_OUTPUT_VERSION: 1` is the version signal; everything below is labeled blocks (`VIDEO:`, `DURATION:`, `FRAMES:`, `TRANSCRIPT:`, `EXIT:`) per the same doc.
- **Read frames as images, transcript as text.** Each path under `FRAMES:` (or each string in `frame_paths`) is an absolute path to a JPG on disk. Pass the path to the host's image-reading primitive. The transcript is plain UTF-8 text — no decoding needed.
- **Exit-code behavior** is documented in [`docs/exit-codes.md`](https://github.com/sonpiaz/watch-cli/blob/main/docs/exit-codes.md). The partial-success case is the one to remember: on `exit 4` the frames are populated and the transcript is `null` — branch on the exit code and fall through to a frames-only consumption path instead of failing the run.

## Invocation

```bash
watch <url> [frame-count]
```

Default frame count is 8. For a fast-cut or dense UI demo, double it. For a multi-hour conference talk, bump to 24–32. The CLI does not cap; agent hosts typically prefer ≤ 32.

## Anti-patterns

- Do not parse stderr. Progress lines on stderr (`[watch] downloading …`) are not part of the contract and change between releases. Programmatic consumers ignore stderr.
- Do not parse the filename of a frame to infer its position. Filenames are implementation detail; the ordering of `frame_paths` is the contract.
- Do not hard-fail on every non-zero exit. `exit 4` is recoverable partial success — frames populated, transcript `null`. Branch on `exit_code` before parsing.
- Do not surface API keys or environment variable names in chat. `KYMA_API_KEY` setup lives in the README.
- Do not embed the locked pitch into a longer marketing paragraph. The description line above is the source of truth; reuse it verbatim where the host shows skill metadata.
