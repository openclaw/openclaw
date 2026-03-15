---
name: obsidian
description: Work with Obsidian vaults (plain Markdown notes) using the official Obsidian CLI. Automate note creation, search, tasks, daily notes, and more.
homepage: https://help.obsidian.md/Obsidian+CLI
metadata:
  {
    "openclaw":
      {
        "emoji": "💎",
        "requires": { "bins": ["obsidian"] },
        "install":
          [
            {
              "id": "mac",
              "kind": "brew",
              "label": "Install Obsidian via Homebrew (macOS)",
              "command": "brew install --cask obsidian",
              "bins": ["obsidian"],
            },
            {
              "id": "win",
              "kind": "winget",
              "label": "Install Obsidian via Winget (Windows)",
              "command": "winget install Obsidian.Obsidian",
              "bins": ["obsidian"],
            },
            {
              "id": "snap",
              "kind": "snap",
              "label": "Install Obsidian via Snap (Linux)",
              "command": "sudo snap install obsidian --classic",
              "bins": ["obsidian"],
            },
            {
              "id": "appimage",
              "kind": "manual",
              "label": "Install Obsidian via AppImage (Linux)",
              "command": "wget https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.4/Obsidian-1.12.4.AppImage && chmod +x Obsidian-1.12.4.AppImage",
              "bins": ["obsidian"],
            },
          ],
      },
  }
---

# Obsidian Official CLI

The Obsidian CLI is the official command-line interface that lets you control Obsidian from your terminal for scripting, automation, and integration with external tools.

## System Requirements

- **Obsidian version:** 1.12 or later
- **Runtime:** Obsidian app must be running (first command launches it automatically)

## Installation and Setup

### 1. Install Obsidian (All Platforms)

**macOS (Homebrew):**
```bash
brew install --cask obsidian
```

**Windows (Winget):**
```bash
winget install Obsidian.Obsidian
```

**Linux (Snap):**
```bash
sudo snap install obsidian --classic
```

**Linux (AppImage):**
```bash
wget https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.4/Obsidian-1.12.4.AppImage
chmod +x Obsidian-1.12.4.AppImage
./Obsidian-1.12.4.AppImage
```

**Download from website:**
Visit https://obsidian.md/download for all platforms.

### 2. Enable CLI

Enable the command-line interface in Obsidian:
1. Open **Settings** → **General**
2. Enable **Command line interface**
3. Follow the prompts to register Obsidian CLI

**Register CLI (if not automatic):**
```bash
# macOS (usually automatic via ~/.zprofile)
export PATH="$PATH:/Applications/Obsidian.app/Contents/MacOS"

# Linux (manual symlink)
sudo ln -s /path/to/obsidian /usr/local/bin/obsidian
```

## Quick Start

### Run Single Commands

```bash
# Run help command
obsidian help
```

### Use Terminal Interface (TUI)

```bash
# Open TUI
obsidian
obsidian help  # Then run help inside TUI
```

The TUI supports autocomplete, command history, and reverse search. Use `Ctrl+R` to search command history.

### Basic Syntax

**Parameters:**
```bash
# Create a note named "Note" with content "Hello world"
obsidian create name=Note content="Hello world"
```

**Flags:**
```bash
# Create note in background and overwrite existing content
obsidian create name=Note content="Hello" silent overwrite
```

**Multiline Content:**
```bash
obsidian create name=Note content="# Title\n\nBody text"
```

### Target a Vault

- If your terminal's current working directory is a vault folder, that vault is used by default
- Otherwise, the currently active vault is used

```bash
# Target a specific vault
obsidian vault=Notes daily
obsidian vault="My Vault" search query="test"
```

### Target a File

```bash
# By filename (no path or extension needed)
obsidian read file=Recipe

# By full path
obsidian read path="Templates/Recipe.md"
```

### Copy Output

```bash
# Copy output to clipboard
obsidian read --copy
obsidian search query="TODO" --copy
```

## Vault Structure

An Obsidian vault is simply a normal folder on disk.

**Typical structure:**
- Notes: `*.md` (plain text Markdown; edit with any editor)
- Config: `.obsidian/` (workspace + plugin settings; usually don't touch from scripts)
- Canvases: `*.canvas` (JSON)
- Attachments: whatever folder you chose in Obsidian settings (images/PDFs/etc.)

**Finding your active vault:**
- On macOS: `~/Library/Application Support/obsidian/obsidian.json`
- On Linux: `~/.config/obsidian/obsidian.json`
- On Windows: `%APPDATA%\Obsidian\obsidian.json`

The vault name is typically the **folder name** (path suffix).

## Common Commands

### Note Operations

**Create notes:**
```bash
obsidian create                              # Default name
obsidian create name=Note content="Hello"   # With content
obsidian create name="Trip" template=Travel # From template
obsidian create name=Note content="..." silent  # Silent creation
```

**Read notes:**
```bash
obsidian read                       # Current active file
obsidian read file=Recipe          # Specific file
obsidian read path="Notes/Recipe.md"  # By path
obsidian read --copy               # Copy to clipboard
```

**Append content:**
```bash
obsidian daily:append content="- [ ] Buy groceries"  # To daily note
obsidian append file=Note content="New paragraph"    # To specific file
obsidian append file=Note content="text" inline      # Without newline
```

**Move/Rename:**
```bash
obsidian move path="Old/Name.md" to="New/Name.md"
```

**Delete:**
```bash
obsidian delete file=Note           # Move to trash
obsidian delete file=Note permanent  # Permanently delete
```

### Daily Notes
```bash
obsidian daily              # Open daily note
obsidian daily:read        # Read content
obsidian daily:append       # Append content
obsidian daily:prepend      # Prepend content
```

### Search
```bash
obsidian search query="meeting notes"      # Search vault
obsidian search query="TODO" path=Projects # Limit scope
obsidian search query="error" matches      # Show context
```

### Tags
```bash
obsidian tags              # List all tags
obsidian tags counts       # With counts
obsidian tag name="#todo"  # Tag info
```

### Task Management
```bash
obsidian tasks             # Current file tasks
obsidian tasks daily       # Daily note tasks
obsidian tasks all        # All tasks
obsidian task line=8 done  # Mark complete
obsidian task ref="Recipe.md:8" toggle  # Toggle status
```

### File and Folder Management
```bash
obsidian files                     # List files
obsidian folders                  # List folders
obsidian file path="Notes/Recipe.md"   # File info
obsidian backlinks file=Note      # Backlinks
obsidian unresolved               # Unresolved links
obsidian orphans                  # Orphaned files
```

### Statistics
```bash
obsidian wordcount         # Word count
```

### History and Recovery
```bash
obsidian diff file=Note              # View diff
obsidian diff file=Note from=2 to=1 # Compare versions
obsidian history file=Note           # Local history
obsidian history:restore version=3   # Restore version
```

### Themes and Snippets
```bash
obsidian themes                     # List themes
obsidian theme:set "Theme Name"    # Set theme
obsidian theme:install "Name" enable  # Install theme
obsidian snippets                  # List snippets
obsidian snippet:enable "name"     # Enable snippet
```

### Plugin Management
```bash
obsidian plugins                    # List plugins
obsidian plugins:enabled           # Enabled plugins
obsidian plugin:install id=xxx enable  # Install plugin
obsidian plugin:enable id=xxx     # Enable plugin
obsidian plugin:disable id=xxx    # Disable plugin
```

### Publish
```bash
obsidian publish:site         # Site info
obsidian publish:list        # Published files
obsidian publish:add file=Note   # Publish file
obsidian publish:remove file=Note  # Unpublish
```

### Sync
```bash
obsidian sync:status          # Sync status
obsidian sync:history         # Sync history
obsidian sync:restore         # Restore version
```

### Workspace
```bash
obsidian workspaces          # List workspaces
obsidian workspace:save "Name"   # Save layout
obsidian workspace:load "Name"  # Load layout
obsidian recents             # Recent files
obsidian tabs                # Open tabs
```

## Developer Commands

### Development Tools
```bash
obsidian devtools           # Open dev tools
obsidian dev:screenshot     # Take screenshot
obsidian dev:eval           # Execute JS
obsidian dev:console        # Console messages
obsidian dev:dom            # DOM queries
obsidian dev:css            # CSS inspection
obsidian plugin:reload      # Reload plugin
obsidian dev:mobile on/off  # Mobile emulation
```

## TUI Shortcuts

### Navigation
| Action | Shortcut |
|--------|----------|
| Move cursor left | ← / Ctrl+B |
| Move cursor right | → / Ctrl+F |
| Jump to line start | Ctrl+A |
| Jump to line end | Ctrl+E |
| Back one word | Alt+B |
| Forward one word | Alt+F |

### Editing
| Action | Shortcut |
|--------|----------|
| Delete to line start | Ctrl+U |
| Delete to line end | Ctrl+K |
| Delete previous word | Ctrl+W / Alt+Backspace |

### Autocomplete
| Action | Shortcut |
|--------|----------|
| Enter suggestion mode | ↓ |
| Accept suggestion | Tab |
| Exit suggestion mode | Shift+Tab |

### History
| Action | Shortcut |
|--------|----------|
| Previous history | ↑ / Ctrl+P |
| Next history | ↓ / Ctrl+N |
| Reverse search | Ctrl+R |

### Other
| Action | Shortcut |
|--------|----------|
| Execute command | Enter |
| Undo/Exit | Escape |
| Clear screen | Ctrl+L |
| Exit | Ctrl+C / Ctrl+D |

## Troubleshooting

### CLI Doesn't Detect Obsidian
1. Ensure Obsidian app is running
2. Restart terminal
3. Verify CLI registration: `which obsidian`

### Linux Symlink Issues
```bash
# Check symlink
ls -l /usr/local/bin/obsidian

# Create manually
sudo ln -s /path/to/obsidian /usr/local/bin/obsidian
```

### Snap Package Issues
```bash
export XDG_CONFIG_HOME="$HOME/snap/obsidian/current/.config"
```

## Usage Examples

### Daily Workflow
```bash
obsidian daily
obsidian daily:append content="- [ ] Morning review"
obsidian search query="TODO"
obsidian tasks daily
```

### Create Notes from Templates
```bash
obsidian templates
obsidian create name="Meeting" template=Meeting
```

### Quick Search
```bash
obsidian recents
```

### Batch Operations (Script)
```bash
#!/bin/bash
# Batch add tags to notes

for note in Notes/*.md; do
  obsidian property:set file="$note" name=tags value="bulk-added" type=list
done
```

## Official Documentation

For complete reference, see: https://help.obsidian.md/Obsidian+CLI
