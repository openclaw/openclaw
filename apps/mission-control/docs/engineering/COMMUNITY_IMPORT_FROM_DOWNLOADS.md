# Community Import From Downloads

This project can import local OpenClaw zip archives from `~/Downloads` into versioned catalogs consumed by Mission Control.

## Imported archives

- `openclaw-main.zip`
- `openclaw-skills-main.zip`
- `awesome-openclaw-usecases-main.zip`

## Command

Run from `/Users/tg/Projects/OpenClaw/openclaw-mission-control`:

```bash
npm run import:downloads
```

Optional custom downloads directory:

```bash
node scripts/import-openclaw-downloads.mjs /absolute/path/to/downloads
```

## Generated files

- `/Users/tg/Projects/OpenClaw/openclaw-mission-control/src/community-catalog/usecases.json`
- `/Users/tg/Projects/OpenClaw/openclaw-mission-control/src/community-catalog/skills.json`

## Where the data is used

- Learning Hub API (`/api/learning-hub/lessons`) merges community usecases with live RSS lessons.
- Skills Dashboard API (`/api/openclaw/community-skills`) exposes imported skills as a new "Community" source.

## Notes

- Import is additive. Existing mission/task/config data is not overwritten.
- If one archive is missing, importer still writes catalogs from whatever is available.
