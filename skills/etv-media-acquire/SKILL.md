---
name: etv-media-acquire
description: Download, validate, catalog, and file media for ErsatzTV. Covers the full pipeline from source URL to library-ready media with NFO metadata on the NUC.
---

# ErsatzTV Media Acquisition

Download media, validate it, write rich NFO metadata, and file it correctly for ErsatzTV.

## NUC Connection

```
SSH="ssh -i ~/.ssh/talwet rabsef-bicrym@192.168.50.188"
```

All commands below run on the NUC via this SSH. yt-dlp and ffprobe are installed on the NUC.

## Pipeline Overview

1. **Source** — Find the best available version (Archive.org > YouTube)
2. **Download to staging** — `/tmp/etv-staging/` on the NUC SSD
3. **Validate** — ffprobe confirms valid video, extract metadata
4. **Research & write NFO** — Web search for rich metadata, write Kodi-format NFO
5. **File** — Move video + NFO to correct ETV library path
6. **Scan** — Trigger ETV library rescan

## Step 1: Source Selection

Prefer Archive.org — better quality, no bot detection, no cookies needed.

```bash
# Search archive.org
$SSH 'yt-dlp --no-download --print "%(title)s | %(id)s | %(duration)s | %(format_note)s" "https://archive.org/details/SEARCH_TERM"'
```

Fallback to YouTube (needs cookies on Mac, not on NUC — test first):

```bash
$SSH 'yt-dlp --no-download --print "%(title)s | %(id)s | %(duration)s" "ytsearch3:QUERY"'
```

## Step 2: Download to Staging

**Target resolution: 720p native or slightly above.** No 4K — limited disk space. 1080p acceptable for feature films if 720p unavailable.

```bash
$SSH 'mkdir -p /tmp/etv-staging && yt-dlp \
  -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]" \
  --merge-output-format mkv \
  -o "/tmp/etv-staging/%(title)s.%(ext)s" \
  "URL"'
```

**CRITICAL: Do NOT poll download progress repeatedly.** Start the download, wait an appropriate time based on file size, then check once. Repeated polling fills the context window and causes output degradation.

Estimate wait time: `file_size_MB / 40` seconds (NUC averages ~40 MB/s).

## Step 3: Validate with ffprobe

```bash
$SSH 'ffprobe -v quiet -print_format json -show_format -show_streams "/tmp/etv-staging/FILENAME"'
```

Confirm:

- `format.duration` > 0 (not corrupt)
- Video stream exists with reasonable resolution
- Audio stream exists
- File size is plausible for duration

If invalid, re-download. Do not move corrupt files to media.

## Step 4: Research & Write NFO

Before writing the NFO, do a web search for the title to gather rich metadata:

- Director, writers, cast
- Plot summary (write something engaging, not just a Wikipedia first sentence)
- Year, country, studio
- Genres, tags

### NFO Formats by Library Type

**Movies** (`/mnt/media/movies/Title (Year)/`):

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>TITLE</title>
  <originaltitle>ORIGINAL_TITLE</originaltitle>
  <year>YEAR</year>
  <plot>Rich, engaging plot description. Be creative — this shows in the EPG.</plot>
  <genre>Genre1</genre>
  <genre>Genre2</genre>
  <country>COUNTRY</country>
  <director>DIRECTOR</director>
  <credits>WRITER</credits>
  <studio>STUDIO</studio>
  <premiered>YYYY-MM-DD</premiered>
  <tag>Optional tags</tag>
  <actor>
    <name>ACTOR NAME</name>
    <role>ROLE</role>
  </actor>
</movie>
```

**TV Shows** (`/mnt/media/shows/Show Name (Year)/`):

- `tvshow.nfo` in show root:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>SHOW NAME</title>
  <year>YEAR</year>
  <plot>Show description.</plot>
  <genre>Genre</genre>
  <premiered>YYYY-MM-DD</premiered>
</tvshow>
```

- Per-episode NFO beside each video:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
  <title>EPISODE TITLE</title>
  <season>N</season>
  <episode>N</episode>
  <plot>Episode description.</plot>
  <aired>YYYY-MM-DD</aired>
</episodedetails>
```

**Music Videos** (`/mnt/media/music_videos/Artist Name/`):

- Filename: `Artist Name - Title.ext`
- NFO: `Artist Name - Title.nfo`

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<musicvideo>
  <title>TITLE</title>
  <artist>ARTIST</artist>
  <album>ALBUM (if applicable)</album>
  <year>YEAR</year>
  <genre>Genre</genre>
  <plot>Description of the video/performance.</plot>
  <director>DIRECTOR</director>
  <tag>Optional tags</tag>
</musicvideo>
```

**Other Videos** (`/mnt/media/other_videos/collection-name/`):

- Use `<movie>` NFO format (ETV reads movie NFO for other_videos)

### NFO Writing Tips

- **Plot text shows in the EPG guide.** Make it good — engaging, informative, fun to read.
- Be creative in the writing. These aren't dry database entries.
- Include interesting production trivia when available.
- For music videos, describe the visual style and performance.

## Step 5: File to Correct Location

Determine the correct library path based on content type:

| Type        | Path Pattern                                                       | Example                                                                        |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Movie       | `/mnt/media/movies/Title (Year)/Title (Year).ext`                  | `/mnt/media/movies/Allegro non Troppo (1976)/Allegro non Troppo (1976).mp4`    |
| Show        | `/mnt/media/shows/Show (Year)/Season NN/Show - SNNENN - Title.ext` | `/mnt/media/shows/Operavox (1995)/Season 01/Operavox - S01E01 - Rigoletto.mkv` |
| Music Video | `/mnt/media/music_videos/Artist/Artist - Title.ext`                | `/mnt/media/music_videos/Barnaby Dixon/Barnaby Dixon - Wellerman.mkv`          |
| Other Video | `/mnt/media/other_videos/collection/filename.ext`                  | `/mnt/media/other_videos/coronet/Are You Popular.mp4`                          |

```bash
# Create directory if needed
$SSH 'mkdir -p "/mnt/media/movies/Title (Year)"'

# Rename video to proper convention
$SSH 'mv "/tmp/etv-staging/downloaded-name.mkv" "/mnt/media/movies/Title (Year)/Title (Year).mkv"'

# Write NFO (use heredoc or echo)
$SSH 'cat > "/mnt/media/movies/Title (Year)/Title (Year).nfo" << '\''EOF'\''
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  ...
</movie>
EOF'
```

**Always move video and NFO together. Never leave orphaned NFOs.**

## Step 6: Trigger Library Scan

If the folder is already registered in ETV, trigger a scan via the API:

```bash
# ETV API is accessible from NUC localhost
$SSH 'curl -s http://localhost:8409/api/libraries' | python3 -m json.tool
```

For new folders not yet in ETV: note that the folder needs to be added via ETV UI under Media Sources > Local. Report this to the user.

**Container path mapping:** Host `/mnt/media/` = Container `/media/`. All ETV paths use `/media/` prefix.

## Batch Downloads

When downloading multiple files (e.g., a series), process them sequentially:

1. Download all to staging first
2. Validate all with ffprobe
3. Write all NFOs
4. Move all to final location
5. Trigger single library scan

For large batches, use a single yt-dlp command with a batch file:

```bash
$SSH 'yt-dlp -a /tmp/urls.txt -f "best[height<=720]" -o "/tmp/etv-staging/%(title)s.%(ext)s"'
```

**Do NOT monitor batch downloads with repeated polling.** Estimate completion time and check once.

## Disk Budget

- Media drive (`/mnt/media`): 229GB total, check `df -h /mnt/media` before large downloads
- SSD (`/`): 449GB total, staging in `/tmp/etv-staging/`
- Clean staging after successful filing: `$SSH 'rm -rf /tmp/etv-staging/*'`

## Existing Content Reference

See the `ersatztv` skill's Channel Registry for current channel assignments. Key library folders already registered in ETV are discoverable via:

```bash
$SSH 'sudo sqlite3 /mnt/media/config/ersatztv.sqlite3 "SELECT Id, Path FROM LibraryFolder"'
```
