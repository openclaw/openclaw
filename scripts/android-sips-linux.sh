#!/bin/bash
set -euo pipefail

fail() {
  printf 'android-sips-linux: %s\n' "$1" >&2
  exit "${2:-1}"
}

if [[ $# -ne 9 ||
  "$1" != "-s" || "$2" != "format" || "$3" != "jpeg" ||
  "$4" != "-s" || "$5" != "formatOptions" || "$6" != "best" ||
  "$8" != "--out" ]]; then
  fail "unsupported arguments" 2
fi

input_path="$7"
output_path="$9"
convert_bin="/usr/bin/convert"
identify_bin="/usr/bin/identify"

[[ "$input_path" == /* && "$output_path" == /* ]] ||
  fail "input and output paths must be absolute" 2
[[ "$input_path" != "$output_path" ]] || fail "input and output paths must differ" 2
[[ -f "$input_path" && ! -L "$input_path" ]] || fail "input is not a regular file"
[[ ! -e "$output_path" && ! -L "$output_path" ]] || fail "output already exists"
[[ -d "${output_path%/*}" ]] || fail "output directory does not exist"

[[ -x "$convert_bin" && -x "$identify_bin" ]] ||
  fail "fixed ImageMagick executables are unavailable" 2

if ! input_dimensions="$("$identify_bin" -ping -format '%w %h' "$input_path" 2>/dev/null)"; then
  fail "input is not a readable image"
fi
read -r input_width input_height extra <<<"$input_dimensions"
[[ "$input_width" =~ ^[1-9][0-9]*$ && "$input_height" =~ ^[1-9][0-9]*$ && -z "${extra:-}" ]] ||
  fail "input dimensions are invalid"

umask 077
temporary_dir="$(mktemp -d "${output_path}.tmp.XXXXXX")"
temporary_output="$temporary_dir/output.jpg"
cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

if ! "$convert_bin" "$input_path" \
  -colorspace sRGB \
  -background white \
  -alpha remove \
  -alpha off \
  -type TrueColor \
  -quality 95 \
  "jpeg:$temporary_output" >/dev/null 2>&1; then
  fail "ImageMagick conversion failed"
fi

if ! output_description="$(
  "$identify_bin" -ping -format '%m|%w|%h|%[colorspace]|%[type]|%[channels]|%Q' \
    "$temporary_output" 2>/dev/null
)"; then
  fail "converted output is not a readable image"
fi
IFS='|' read -r output_format output_width output_height output_colorspace \
  output_type output_channels output_quality <<<"$output_description"
output_colorspace="$(printf '%s' "$output_colorspace" | tr '[:upper:]' '[:lower:]')"
output_channels="$(printf '%s' "$output_channels" | tr '[:upper:]' '[:lower:]')"

[[ "$output_format" == "JPEG" ]] || fail "converted output is not JPEG"
[[ "$output_width" == "$input_width" && "$output_height" == "$input_height" ]] ||
  fail "converted output dimensions changed"
[[ "$output_colorspace" == "srgb" ]] || fail "converted output is not sRGB"
[[ "$output_type" == "TrueColor" ]] || fail "converted output is not true color"
[[ "$output_channels" != *a* ]] || fail "converted output retained an alpha channel"
[[ "$output_quality" =~ ^[0-9]+$ && "$output_quality" -ge 90 ]] ||
  fail "converted output quality is too low"

mv "$temporary_output" "$output_path"
