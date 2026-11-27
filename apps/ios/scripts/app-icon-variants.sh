#!/usr/bin/env bash
set -euo pipefail

# The approved artwork is the pair of 1024 px PNGs in each iOS icon set:
# 1024.png (Default) and 1024-dark.png (Dark). They are flattened bitmaps with
# no vector source. To change an icon, replace those two files and run
# `generate`, which redraws every smaller size and the Watch icon sets from
# 1024.png. The Tinted slot has no file, so the system derives it.

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
ios_catalog="$repo_root/apps/ios/Sources/Assets.xcassets"
watch_catalog="$repo_root/apps/ios/WatchApp/Assets.xcassets"
icon_sets=(AppIcon AppIconDebug)
watch_source_name="watch-marketing-1024.png"

preflight() {
  if ! command -v node >/dev/null 2>&1; then
    echo "app-icon-variants: missing node; install the repository's required Node.js version" >&2
    exit 1
  fi
  if [[ ! -x /usr/bin/sips ]]; then
    echo "app-icon-variants: /usr/bin/sips is required; run this generator on macOS" >&2
    exit 1
  fi
}

# Prints "<filename> <pixels>" for every resized image an icon set declares.
resized_images() {
  node - "$1/Contents.json" <<'NODE'
const fs = require("node:fs");

const { images } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sizes = new Map();
for (const image of images) {
  if (!image.filename || !image.scale) continue;
  const pixels = Math.round(Number.parseFloat(image.size) * Number.parseInt(image.scale, 10));
  if (pixels === 1024) continue;
  if (sizes.has(image.filename) && sizes.get(image.filename) !== pixels) {
    throw new Error(`${image.filename} is declared at two pixel sizes`);
  }
  sizes.set(image.filename, pixels);
}
for (const [filename, pixels] of sizes) console.log(`${filename} ${pixels}`);
NODE
}

render_icon_set() {
  local source="$1" icon_set="$2" output_dir="$3" filename pixels
  while read -r filename pixels; do
    /usr/bin/sips -z "$pixels" "$pixels" "$source" --out "$output_dir/$filename" >/dev/null
  done < <(resized_images "$icon_set")
}

render_all() {
  local output_root="$1" name
  for name in "${icon_sets[@]}"; do
    mkdir -p "$output_root/ios/$name" "$output_root/watch/$name"
    render_icon_set "$ios_catalog/$name.appiconset/1024.png" \
      "$ios_catalog/$name.appiconset" "$output_root/ios/$name"
    cp "$ios_catalog/$name.appiconset/1024.png" "$output_root/watch/$name/$watch_source_name"
    render_icon_set "$ios_catalog/$name.appiconset/1024.png" \
      "$watch_catalog/$name.appiconset" "$output_root/watch/$name"
  done
}

check_manifests() {
  local name
  for name in "${icon_sets[@]}"; do
    node - "$ios_catalog/$name.appiconset" "$watch_catalog/$name.appiconset" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [iosIconSet, watchIconSet] = process.argv.slice(2);
const catalogName = path.basename(iosIconSet, ".appiconset");
const read = (iconSet) =>
  JSON.parse(fs.readFileSync(path.join(iconSet, "Contents.json"), "utf8")).images;
const luminosity = (image) =>
  image.appearances?.find((entry) => entry.appearance === "luminosity")?.value;

const images = read(iosIconSet);
const dark = images.filter((image) => luminosity(image) === "dark");
const tinted = images.filter((image) => luminosity(image) === "tinted");
const marketing = images.filter(
  (image) => image.idiom === "ios-marketing" && image.size === "1024x1024" && image.scale === "1x",
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
  throw new Error(
    `${catalogName} must declare its Default image, one custom Dark image, and one automatic Tinted slot`,
  );
}

for (const [iconSet, declared] of [
  [iosIconSet, images],
  [watchIconSet, read(watchIconSet)],
]) {
  for (const filename of new Set(declared.flatMap((image) => image.filename ?? []))) {
    if (!fs.existsSync(path.join(iconSet, filename))) {
      throw new Error(`${iconSet} references missing file: ${filename}`);
    }
  }
}
NODE
  done
}

# iOS draws these full-bleed and applies its own mask, so both appearances are
# opaque squares. sRGB is declared so the colors do not depend on the reader.
check_artwork() {
  local name
  for name in "${icon_sets[@]}"; do
    node - "$ios_catalog/$name.appiconset/1024.png" "$ios_catalog/$name.appiconset/1024-dark.png" <<'NODE'
const fs = require("node:fs");

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

for (const imagePath of process.argv.slice(2)) {
  const data = fs.readFileSync(imagePath);
  if (!data.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${imagePath} is not a PNG`);
  }

  let offset = 8;
  let header;
  let hasSRGBChunk = false;
  let iccProfileName;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
      };
    } else if (type === "sRGB") {
      hasSRGBChunk = true;
    } else if (type === "iCCP") {
      iccProfileName = body.subarray(0, body.indexOf(0)).toString("latin1");
    }
    offset += 12 + length;
    if (type === "IEND") break;
  }

  if (!header || header.width !== 1024 || header.height !== 1024 || header.bitDepth !== 8) {
    throw new Error(`${imagePath} must be an 8-bit 1024x1024 PNG`);
  }
  if (header.colorType === 4 || header.colorType === 6) {
    throw new Error(`${imagePath} must be opaque, with no alpha channel`);
  }
  if (!hasSRGBChunk && !iccProfileName?.toLowerCase().startsWith("srgb")) {
    throw new Error(`${imagePath} must declare an sRGB color profile`);
  }
}
NODE
  done
}

case "${1:-check}" in
  generate)
    preflight
    check_manifests
    check_artwork
    temp_dir="$(mktemp -d /tmp/openclaw-app-icon-variants.XXXXXX)"
    trap 'rm -rf "$temp_dir"' EXIT
    render_all "$temp_dir"
    for name in "${icon_sets[@]}"; do
      cp "$temp_dir/ios/$name/"* "$ios_catalog/$name.appiconset/"
      cp "$temp_dir/watch/$name/"* "$watch_catalog/$name.appiconset/"
    done
    ;;
  check)
    preflight
    check_manifests
    check_artwork
    temp_dir="$(mktemp -d /tmp/openclaw-app-icon-variants.XXXXXX)"
    trap 'rm -rf "$temp_dir"' EXIT
    render_all "$temp_dir"
    for name in "${icon_sets[@]}"; do
      for rendered in "$temp_dir/ios/$name/"*; do
        cmp "$rendered" "$ios_catalog/$name.appiconset/$(basename "$rendered")"
      done
      for rendered in "$temp_dir/watch/$name/"*; do
        cmp "$rendered" "$watch_catalog/$name.appiconset/$(basename "$rendered")"
      done
    done
    echo "AppIcon and AppIconDebug artwork, sizes, and Watch icon sets are valid."
    ;;
  *)
    echo "usage: $0 [generate|check]" >&2
    exit 2
    ;;
esac
