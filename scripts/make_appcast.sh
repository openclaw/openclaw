#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ZIP=${1:?"Usage: $0 OpenClaw-<ver>.zip [feed-url] [--delta-from previous.zip --output-dir new-directory]"}
shift
FEED_URL="https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml"
if [[ $# -gt 0 && "$1" != --* ]]; then
  FEED_URL=${1:-$FEED_URL}
  shift
fi
DELTA_FROM=""
OUTPUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delta-from|--output-dir)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Missing value for $1" >&2
        exit 1
      fi
      if [[ "$1" == --delta-from ]]; then DELTA_FROM=$2; else OUTPUT_DIR=$2; fi
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [[ -n "$DELTA_FROM" && -z "$OUTPUT_DIR" ]]; then
  echo "--delta-from requires --output-dir; experimental feeds must not replace appcast.xml." >&2
  exit 1
fi
if [[ -n "$OUTPUT_DIR" && -e "$OUTPUT_DIR" ]]; then
  echo "Output directory already exists: $OUTPUT_DIR" >&2
  exit 1
fi
PRIVATE_KEY_FILE=${SPARKLE_PRIVATE_KEY_FILE:-}

find_generate_appcast() {
  if [[ -n "${SPARKLE_GENERATE_APPCAST:-}" ]]; then
    if [[ ! -x "$SPARKLE_GENERATE_APPCAST" ]]; then
      echo "SPARKLE_GENERATE_APPCAST is not executable: $SPARKLE_GENERATE_APPCAST" >&2
      return 1
    fi
    printf '%s\n' "$SPARKLE_GENERATE_APPCAST"
    return 0
  fi

  local host_arch bundled_root bundled_tool
  host_arch="$(uname -m)"
  bundled_root="$ROOT/apps/macos/.build/$host_arch"
  if [[ -d "$bundled_root" ]]; then
    bundled_tool="$(find "$bundled_root" -type f -path "*/artifacts/sparkle/Sparkle/bin/generate_appcast" -print -quit)"
    if [[ -n "$bundled_tool" ]]; then
      printf '%s\n' "$bundled_tool"
      return 0
    fi
  fi

  if command -v generate_appcast >/dev/null 2>&1; then
    command -v generate_appcast
    return 0
  fi

  if [[ -d "$ROOT/apps/macos/.build" ]]; then
    find "$ROOT/apps/macos/.build" -type f -path "*/artifacts/sparkle/Sparkle/bin/generate_appcast" -print -quit
  fi
  return 0
}

if [[ -z "$PRIVATE_KEY_FILE" ]]; then
  echo "Set SPARKLE_PRIVATE_KEY_FILE to your ed25519 private key (Sparkle)." >&2
  exit 1
fi
if [[ ! -f "$ZIP" ]]; then
  echo "Zip not found: $ZIP" >&2
  exit 1
fi

ZIP_DIR=$(cd "$(dirname "$ZIP")" && pwd)
ZIP_NAME=$(basename "$ZIP")
ZIP_BASE="${ZIP_NAME%.zip}"
VERSION=${SPARKLE_RELEASE_VERSION:-}
if [[ -z "$VERSION" ]]; then
  # Accept legacy calver suffixes like -1 and prerelease forms like -alpha.1 / -beta.1 / .beta.1.
  if [[ "$ZIP_NAME" =~ ^OpenClaw-([0-9]+(\.[0-9]+){1,2}([-.][0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?)\.zip$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
  else
    echo "Could not infer version from $ZIP_NAME; set SPARKLE_RELEASE_VERSION." >&2
    exit 1
  fi
fi

# Bash 3.2 treats an empty array as unset under nounset, so keep a required option.
APPCAST_ARGS=(--embed-release-notes)
if [[ "$VERSION" == *-alpha.* || "$VERSION" == *.alpha.* ]]; then
  echo "Alpha releases do not ship via Sparkle: $VERSION" >&2
  exit 1
fi
if [[ "$VERSION" == *-beta.* || "$VERSION" == *.beta.* ]]; then
  APPCAST_ARGS+=(--channel beta)
elif [[ "$VERSION" =~ ^[0-9]{4}\.[1-9][0-9]*\.([0-9]+)$ && "${BASH_REMATCH[1]}" -ge 33 ]]; then
  APPCAST_ARGS+=(--channel extended-stable)
fi

TMP_DIR="$(mktemp -d)"
NOTES_HTML=""
cleanup() {
  rm -rf "$TMP_DIR"
  if [[ -n "$NOTES_HTML" && "${KEEP_SPARKLE_NOTES:-0}" != "1" ]]; then
    rm -f "$NOTES_HTML"
  fi
}
trap cleanup EXIT
cp -f "$ZIP" "$TMP_DIR/$ZIP_NAME"
if [[ -n "$DELTA_FROM" ]]; then
  if [[ ! -f "$DELTA_FROM" || "$(basename "$DELTA_FROM")" == "$ZIP_NAME" ]]; then
    echo "--delta-from must name an existing previous archive with a different filename." >&2
    exit 1
  fi
  cp -f "$DELTA_FROM" "$TMP_DIR/$(basename "$DELTA_FROM")"
  APPCAST_ARGS+=(--maximum-deltas 1 --maximum-versions 1)
fi
# Experimental output starts a separate feed; production history remains untouched.
if [[ -z "$OUTPUT_DIR" && -f "$ROOT/appcast.xml" ]]; then
  cp -f "$ROOT/appcast.xml" "$TMP_DIR/appcast.xml"
fi

NOTES_HTML="${ZIP_DIR}/${ZIP_BASE}.html"
if [[ -x "$ROOT/scripts/changelog-to-html.sh" ]]; then
  "$ROOT/scripts/changelog-to-html.sh" "$VERSION" >"$NOTES_HTML"
else
  echo "Missing scripts/changelog-to-html.sh; cannot generate HTML release notes." >&2
  exit 1
fi
cp -f "$NOTES_HTML" "$TMP_DIR/${ZIP_BASE}.html"

DOWNLOAD_URL_PREFIX=${SPARKLE_DOWNLOAD_URL_PREFIX:-"https://github.com/openclaw/openclaw/releases/download/v${VERSION}/"}

GENERATE_APPCAST="$(find_generate_appcast)"
if [[ -z "$GENERATE_APPCAST" ]]; then
  echo "generate_appcast not found. Install Sparkle tooling or build the mac app first so SwiftPM emits the Sparkle binaries." >&2
  exit 1
fi

# Sparkle 2.10 otherwise names the feed after the app's SUFeedURL basename (appcast-arm64.xml).
"$GENERATE_APPCAST" \
  --ed-key-file "$PRIVATE_KEY_FILE" \
  -o "$TMP_DIR/appcast.xml" \
  --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
  --link "$FEED_URL" \
  "${APPCAST_ARGS[@]}" \
  "$TMP_DIR"

APPCAST_PATH="$TMP_DIR/appcast.xml" APPCAST_VERSION="$VERSION" \
APPCAST_OUTPUT_DIR="$OUTPUT_DIR" APPCAST_ZIP="$ZIP" APPCAST_NOTES="$NOTES_HTML" \
APPCAST_DOWNLOAD_PREFIX="$DOWNLOAD_URL_PREFIX" node <<'NODE'
const { copyFileSync, mkdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

const appcastPath = process.env.APPCAST_PATH;
const version = process.env.APPCAST_VERSION;
const appcast = readFileSync(appcastPath, "utf8");
const items = [...appcast.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gu)];
const item = items.find((match) =>
  match[1]?.includes("<sparkle:shortVersionString>" + version + "</sparkle:shortVersionString>"),
);
if (!item) {
  throw new Error("Generated appcast is missing release " + version);
}
const deltaBlock = item[1].match(/<sparkle:deltas(?:\s[^>]*)?>([\s\S]*?)<\/sparkle:deltas>/u);
const fullBody = item[1].replace(deltaBlock?.[0] ?? "", "");
const full = fullBody.match(/<enclosure\b[^>]*>/u)?.[0];
const attribute = (tag, name) => tag?.match(new RegExp(name + '="([^"]*)"', "u"))?.[1];
if (!attribute(full, "sparkle:edSignature")) {
  throw new Error("Generated appcast release " + version + " is missing sparkle:edSignature on its full download.");
}

const output = process.env.APPCAST_OUTPUT_DIR;
if (output) {
  // Only the selected release's assets are exported. A mixed-branch input needs separate feeds.
  if (items.length !== 1) {
    throw new Error("Experimental output requires one release; use matching architecture/channel/OS baselines.");
  }
  const prefix = process.env.APPCAST_DOWNLOAD_PREFIX;
  const validate = (tag, file) => {
    if (!attribute(tag, "sparkle:edSignature") ||
        attribute(tag, "url") !== prefix + path.basename(file) ||
        Number(attribute(tag, "length")) !== statSync(file).size) {
      throw new Error("Generated enclosure does not match signed artifact " + path.basename(file));
    }
    return file;
  };
  const files = [validate(full, process.env.APPCAST_ZIP)];
  const deltas = [...(deltaBlock?.[1] ?? "").matchAll(/<enclosure\b[^>]*>/gu)];
  if (deltas.length > 1) throw new Error("Experimental output supports one baseline delta");
  for (const [tag] of deltas) {
    const url = attribute(tag, "url");
    const name = url?.slice(prefix.length);
    if (!url?.startsWith(prefix) || !name || path.basename(name) !== name || !name.endsWith(".delta") ||
        !attribute(tag, "sparkle:deltaFrom")) {
      throw new Error("Invalid generated delta enclosure");
    }
    files.push(validate(tag, path.join(path.dirname(appcastPath), name)));
  }
  mkdirSync(output);
  for (const file of files) copyFileSync(file, path.join(output, path.basename(file)));
  copyFileSync(process.env.APPCAST_NOTES, path.join(output, path.basename(process.env.APPCAST_NOTES)));
  // Copy the feed last: an incomplete export must not advertise unavailable artifacts.
  copyFileSync(appcastPath, path.join(output, "appcast.xml"));
  console.log("Isolated appcast exported: " + deltas.length + " delta(s), full download retained.");
}
NODE

if [[ -z "$OUTPUT_DIR" ]]; then
  cp -f "$TMP_DIR/appcast.xml" "$ROOT/appcast.xml"
  echo "Appcast generated (appcast.xml). Upload alongside $ZIP at $FEED_URL"
else
  echo "Experimental artifacts exported to $OUTPUT_DIR; nothing uploaded or changed in the production feed."
fi
