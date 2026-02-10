---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: gifgrep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Search GIF providers with CLI/TUI, download results, and extract stills/sheets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://gifgrep.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🧲",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["gifgrep"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/gifgrep",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["gifgrep"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install gifgrep (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/steipete/gifgrep/cmd/gifgrep@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["gifgrep"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install gifgrep (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# gifgrep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `gifgrep` to search GIF providers (Tenor/Giphy), browse in a TUI, download results, and extract stills or sheets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
GIF-Grab (gifgrep workflow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Search → preview → download → extract (still/sheet) for fast review and sharing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gifgrep cats --max 5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gifgrep cats --format url | head -n 5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gifgrep search --json cats | jq '.[0].url'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gifgrep tui "office handshake"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gifgrep cats --download --max 1 --format url`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TUI + previews（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: `gifgrep tui "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI still previews: `--thumbs` (Kitty/Ghostty only; still frame)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Download + reveal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--download` saves to `~/Downloads`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reveal` shows the last download in Finder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stills + sheets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gifgrep still ./clip.gif --at 1.5s -o still.png`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gifgrep sheet ./clip.gif --frames 9 --cols 3 -o sheet.png`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sheets = single PNG grid of sampled frames (great for quick review, docs, PRs, chat).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tune: `--frames` (count), `--cols` (grid width), `--padding` (spacing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--source auto|tenor|giphy`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GIPHY_API_KEY` required for `--source giphy`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `TENOR_API_KEY` optional (Tenor demo key used if unset)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json` prints an array of results (`id`, `title`, `url`, `preview_url`, `tags`, `width`, `height`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--format` for pipe-friendly fields (e.g., `url`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Environment tweaks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GIFGREP_SOFTWARE_ANIM=1` to force software animation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GIFGREP_CELL_ASPECT=0.5` to tweak preview geometry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
