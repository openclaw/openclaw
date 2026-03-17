const DIFF_LAYOUTS = ["unified", "split"];
const DIFF_MODES = ["view", "image", "file", "both"];
const DIFF_THEMES = ["light", "dark"];
const DIFF_INDICATORS = ["bars", "classic", "none"];
const DIFF_IMAGE_QUALITY_PRESETS = ["standard", "hq", "print"];
const DIFF_OUTPUT_FORMATS = ["png", "pdf"];
const DIFF_ARTIFACT_ID_PATTERN = /^[0-9a-f]{20}$/;
const DIFF_ARTIFACT_TOKEN_PATTERN = /^[0-9a-f]{48}$/;
export {
  DIFF_ARTIFACT_ID_PATTERN,
  DIFF_ARTIFACT_TOKEN_PATTERN,
  DIFF_IMAGE_QUALITY_PRESETS,
  DIFF_INDICATORS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_OUTPUT_FORMATS,
  DIFF_THEMES
};
