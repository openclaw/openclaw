# Avatars

## Preset vs Custom

| | Preset | Custom |
|---|---|---|
| Source | Curated by Higgsfield | User-uploaded |
| Cost | None for selection | Cost of upload |
| Diversity | Limited but professional | Unlimited |
| Use when | Generic ad, fast turnaround | Brand-specific face, founder, employee |

## Listing presets

```bash
higgsfield marketing-studio avatars list
higgsfield marketing-studio avatars list --json | jq '.[] | select(.gender=="female")'
```

Filter by `name`, `gender`, etc. on the JSON output.

## Creating a custom avatar

```bash
ID=$(higgsfield upload create founder.png)
URL=$(higgsfield upload create founder.png --json | jq -r .url)   # if you need cloudfront URL
higgsfield marketing-studio avatars create --name "Founder" --image $ID --image-url $URL
```

`--image-url` is the cloudfront URL from the upload. Required by the API.

## Passing to video

```bash
higgsfield generate create marketing_studio_video \
  --avatars '[{"id":"<avatar_id>","type":"preset"}]' \
  ... \
  --wait
```

`type` is `preset` for curated, `custom` for user-created.
