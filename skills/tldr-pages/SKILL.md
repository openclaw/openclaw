---
name: tldr-pages
description: "Get instant, practical CLI command cheat-sheets using the tldr command. Use when: user asks 'how do I use [command]', 'what are the options for [cli tool]', 'show me examples of [command]', or 'tldr [tool]'. Requires tldr installed. NOT for: man pages deep-dives, programming language docs, or APIs (use relevant skill)."
homepage: https://tldr.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "📖",
        "requires": { "bins": ["tldr"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "tldr",
              "bins": ["tldr"],
              "label": "Install tldr (npm)"
            },
            {
              "id": "brew",
              "kind": "brew",
              "formula": "tlrc",
              "bins": ["tldr"],
              "label": "Install tlrc (brew)"
            }
          ]
      }
  }
---

# tldr-pages Skill

Get fast, community-maintained cheat-sheets for any CLI command. Much shorter and more practical than `man` pages — just the most useful examples.

## When to Use

✅ **USE this skill when:**

- "How do I use `rsync`?"
- "Show me examples for `ffmpeg`"
- "tldr curl"
- "What are the options for `tar`?"
- User needs quick CLI examples without reading a full man page

❌ **DON'T use this skill when:**

- Detailed flag reference or edge cases → use `man <command>` or `<command> --help`
- Programming library docs → use official docs or search
- The command is very new/niche and may not have a tldr page

---

## Commands

### Look Up a Command

```bash
# Basic lookup
tldr curl

# Look up for a specific platform
tldr --platform linux tar
tldr --platform osx brew
tldr --platform windows winget
```

### Update the tldr Cache

```bash
# Update the local cache (run periodically)
tldr --update
```

### List All Available Pages

```bash
# List everything in the cache
tldr --list | grep -i "docker"
```

### Search for a Topic

```bash
# Find commands related to a keyword
tldr --list | grep -i "compress"
tldr --list | grep -i "network"
```

---

## Quick Examples

**"How do I copy files with rsync?"**

```bash
tldr rsync
```

**"Show me git shortcuts"**

```bash
tldr git
tldr git-log
tldr git-stash
```

**"ffmpeg cheat-sheet"**

```bash
tldr ffmpeg
```

---

## Output Example

When you run `tldr tar`, you get:

```
  tar

  Archiving utility.
  Often combined with a compression method, such as gzip or bzip2.

  - Create an archive and write it to a file:
    tar cf target.tar file1 file2 file3

  - Create a gzipped archive:
    tar czf target.tar.gz file1 file2 file3

  - Extract a (compressed) archive into the current directory:
    tar xf source.tar[.gz|.bz2|.xz]
```

---

## Notes

- tldr pages are community-contributed at https://github.com/tldr-pages/tldr
- If a page isn't found locally, run `tldr --update` to refresh the cache
- Platform-specific pages exist for `linux`, `osx`, `windows`, `android`, `sunos`
- Pages are written in Markdown and stored in `~/.tldr/` locally
- The Rust client `tlrc` (installed via brew as `tldr`) is faster than the npm version
