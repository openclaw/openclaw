#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
icon_set="$repo_root/apps/ios/Sources/Assets.xcassets/AppIcon.appiconset"
manifest="$icon_set/Contents.json"
source_svg="$repo_root/ui/public/favicon.svg"
dark_icon="$icon_set/1024-dark.png"

render_dark_icon() {
  local output="$1"
  /usr/bin/sips -z 1024 1024 -s format png "$source_svg" --out "$output" >/dev/null
}

check_manifest() {
  node - "$manifest" "$icon_set" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [manifestPath, iconSetPath] = process.argv.slice(2);
const { images } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const luminosity = (image) =>
  image.appearances?.find((entry) => entry.appearance === "luminosity")?.value;

const dark = images.filter((image) => luminosity(image) === "dark");
const tinted = images.filter((image) => luminosity(image) === "tinted");
const marketing = images.filter(
  (image) =>
    image.idiom === "ios-marketing" &&
    image.size === "1024x1024" &&
    image.scale === "1x",
);

if (
  marketing.length !== 1 ||
  marketing[0].filename !== "1024.png" ||
  dark.length !== 1 ||
  dark[0].filename !== "1024-dark.png" ||
  dark[0].idiom !== "universal" ||
  dark[0].platform !== "ios" ||
  dark[0].size !== "1024x1024" ||
  tinted.length !== 1 ||
  Object.hasOwn(tinted[0], "filename") ||
  tinted[0].idiom !== "universal" ||
  tinted[0].platform !== "ios" ||
  tinted[0].size !== "1024x1024"
) {
  throw new Error("AppIcon must declare the existing Default image, one custom Dark image, and one automatic Tinted slot");
}

for (const filename of new Set(images.flatMap((image) => image.filename ?? []))) {
  if (!fs.existsSync(path.join(iconSetPath, filename))) {
    throw new Error(`AppIcon references missing file: ${filename}`);
  }
}
NODE
}

check_png() {
  local image="$1"
  local expected_alpha="$2"
  local expected_profile="$3"
  local properties
  properties="$(/usr/bin/sips -g pixelWidth -g pixelHeight -g format -g space -g profile -g hasAlpha "$image")"

  grep -Fq "pixelWidth: 1024" <<<"$properties"
  grep -Fq "pixelHeight: 1024" <<<"$properties"
  grep -Fq "format: png" <<<"$properties"
  grep -Fq "space: RGB" <<<"$properties"
  grep -Fq "profile: $expected_profile" <<<"$properties"
  grep -Fq "hasAlpha: $expected_alpha" <<<"$properties"
}

case "${1:-check}" in
  generate)
    render_dark_icon "$dark_icon"
    ;;
  check)
    check_manifest
    check_png "$icon_set/1024.png" no "<nil>"
    check_png "$dark_icon" yes "sRGB IEC61966-2.1"

    temp_dir="$(mktemp -d /tmp/openclaw-app-icon-variants.XXXXXX)"
    trap 'rm -rf "$temp_dir"' EXIT
    render_dark_icon "$temp_dir/1024-dark.png"
    cmp "$dark_icon" "$temp_dir/1024-dark.png"
    echo "AppIcon Default, Dark, and automatic Tinted variants are valid."
    ;;
  *)
    echo "usage: $0 [generate|check]" >&2
    exit 2
    ;;
esac
