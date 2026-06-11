---
summary: "Prompt-first Music Studio dashboard for original songs, stems, vocals, and provider handoff"
read_when:
  - You want to use or change the Music Studio dashboard
  - You are working on prompt-first music creation in Control UI
  - You need music_generate provider handoff context
title: "Music Studio"
---

Music Studio is a local-first Control UI dashboard for creating original music
plans with OpenClaw or Codex assistance. It is designed around the same simple
creative loop as SNES Studio:

**Prompt → Preview → Apply → Drag/Edit → Play → Undo/Refine → Finish**

The dashboard is usable before Gateway authentication. Local project planning,
arrangement, snapshots, undo, and export packet creation do not require provider
secrets. Live audio generation still requires a configured music-generation
provider such as Google Lyria, MiniMax, or ComfyUI.

## Beginner surface

Music Studio has four beginner-readable modes:

- **Create**: prompt a complete song or start from the default playable demo.
- **Arrange**: drag tracks into song sections and prompt selected parts.
- **Play**: audition the local arrangement preview.
- **Finish**: export project JSON, create a `music_generate` provider packet, or
  prepare a GarageBand bridge plan.

A single persistent prompt bar stays visible across all modes. The target picker
can create or change:

- Whole Song
- Selected Part
- Beat / Drums
- Bass
- Chords
- Melody
- Vocals
- Lyrics
- Sound FX
- Arrangement
- Mix
- Finish Fix

The provider picker chooses OpenClaw or Codex for the prompt plan. **Preview**
prepares an approval-gated change. **Apply** commits the change and records undo
history. **Play Now** starts the local transport preview from every major mode.

## Arrange mode

Arrange mode exposes a parts shelf and arrangement canvas. Track cards are
clickable and draggable. Dropping a track onto a section binds that track to the
section. Selecting a track or section opens the same selected-part sheet with:

- Name and purpose context
- Prompt this part
- Apply Change
- Preview
- Test
- Undo

## Finish mode

Finish mode keeps provider-backed generation explicit. It builds a readable
`music_generate` packet from the local song plan, plus project export and
GarageBand bridge actions. Music Studio does not store provider secrets; provider
keys remain in the normal OpenClaw credential/config surfaces.

## Generate real audio

The local **Create**, **Preview**, **Apply**, and **Play** controls edit and
audition the dashboard song plan. To start provider-backed audio generation from
the dashboard, click **Generate Audio** in the Provider Audio panel.

The dashboard first checks whether the active Gateway agent exposes
`music_generate`. If the tool is available, Music Studio sends the current
provider packet to the active Chat session and tells the agent to call
`music_generate` exactly once. The generated track appears in Chat when the
background music task completes.

If `music_generate` is not available, the dashboard shows a setup blocker instead
of silently doing nothing. Configure a supported provider such as Google Lyria,
MiniMax, or ComfyUI, then refresh the dashboard and try **Generate Audio** again.

For provider setup and supported models, see [Music generation](/tools/music-generation).
