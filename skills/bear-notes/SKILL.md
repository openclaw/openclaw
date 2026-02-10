---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: bear-notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Create, search, and manage Bear notes via grizzly CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://bear.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🐻",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "os": ["darwin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["grizzly"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/tylerwince/grizzly/cmd/grizzly@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["grizzly"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install grizzly (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bear Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `grizzly` to create, read, and manage notes in Bear on macOS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bear app installed and running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For some operations (add-text, tags, open-note --selected), a Bear app token (stored in `~/.config/grizzly/token`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Getting a Bear Token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For operations that require a token (add-text, tags, open-note --selected), you need an authentication token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Open Bear → Help → API Token → Copy Token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Save it: `echo "YOUR_TOKEN" > ~/.config/grizzly/token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "Note content here" | grizzly create --title "My Note" --tag work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grizzly create --title "Quick Note" --tag inbox < /dev/null（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open/read a note by ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grizzly open-note --id "NOTE_ID" --enable-callback --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Append text to a note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "Additional content" | grizzly add-text --id "NOTE_ID" --mode append --token-file ~/.config/grizzly/token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List all tags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grizzly tags --enable-callback --json --token-file ~/.config/grizzly/token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search notes (via open-tag)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grizzly open-tag --name "work" --enable-callback --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dry-run` — Preview the URL without executing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--print-url` — Show the x-callback-url（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--enable-callback` — Wait for Bear's response (needed for reading data)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json` — Output as JSON (when using callbacks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token-file PATH` — Path to Bear API token file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Grizzly reads config from (in priority order):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. CLI flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Environment variables (`GRIZZLY_TOKEN_FILE`, `GRIZZLY_CALLBACK_URL`, `GRIZZLY_TIMEOUT`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `.grizzly.toml` in current directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. `~/.config/grizzly/config.toml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example `~/.config/grizzly/config.toml`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
token_file = "~/.config/grizzly/token"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
callback_url = "http://127.0.0.1:42123/success"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
timeout = "5s"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bear must be running for commands to work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Note IDs are Bear's internal identifiers (visible in note info or via callbacks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--enable-callback` when you need to read data back from Bear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Some operations require a valid token (add-text, tags, open-note --selected)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
