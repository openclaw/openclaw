#!/usr/bin/env node

const PACKAGE_NAME = "@openclaw/security-gate";
const VERSION = "0.0.1";
const PACKAGE_LABEL = `${PACKAGE_NAME}@${VERSION}`;
const BASE_URL = "https://clawhub.ai";
const PACKAGE_PATH = `/plugins/${PACKAGE_NAME}`;
const LINKS = {
  plugin: `${BASE_URL}${PACKAGE_PATH}`,
  clawscan: `${BASE_URL}${PACKAGE_PATH}/security/clawscan`,
  staticAnalysis: `${BASE_URL}${PACKAGE_PATH}/security/static-analysis`,
  virustotal: `${BASE_URL}${PACKAGE_PATH}/security/virustotal`,
};

const args = new Set(process.argv.slice(2));
const scenario = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "suspicious";
const plain = args.has("--plain") || process.env.NO_COLOR === "1" || process.env.TERM === "dumb";
const useHyperlinks = !plain && process.stdout.isTTY && !args.has("--raw-links-only");
const showRawLinks = !args.has("--no-raw-links");
const columns = Math.max(72, Math.min(process.stdout.columns || 88, 104));
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function osc8(label, url) {
  if (!useHyperlinks) {
    return label;
  }
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

function color(code, value) {
  if (plain) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

function red(value) {
  return color("31;1", value);
}

function yellow(value) {
  return color("33;1", value);
}

function dim(value) {
  return color("2", value);
}

function visibleLength(value) {
  return splitGraphemes(stripAnsi(value)).reduce(
    (sum, grapheme) => sum + graphemeWidth(grapheme),
    0,
  );
}

function stripAnsi(value) {
  let stripped = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== ESC) {
      stripped += value[index];
      index += 1;
      continue;
    }

    const marker = value[index + 1];
    if (marker === "]") {
      const end = value.indexOf(BEL, index + 2);
      index = end === -1 ? value.length : end + 1;
      continue;
    }
    if (marker === "[") {
      let end = index + 2;
      while (end < value.length && !/[A-Za-z]/u.test(value[end])) {
        end += 1;
      }
      index = end < value.length ? end + 1 : value.length;
      continue;
    }

    index += 1;
  }
  return stripped;
}

function splitGraphemes(value) {
  if (!value) {
    return [];
  }
  if (!graphemeSegmenter) {
    return Array.from(value);
  }
  try {
    return Array.from(graphemeSegmenter.segment(value), (segment) => segment.segment);
  } catch {
    return Array.from(value);
  }
}

function isZeroWidthCodePoint(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200d
  );
}

function isFullWidthCodePoint(codePoint) {
  if (codePoint < 0x1100) {
    return false;
  }
  return (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1aff0 && codePoint <= 0x1aff3) ||
    (codePoint >= 0x1aff5 && codePoint <= 0x1affb) ||
    (codePoint >= 0x1affd && codePoint <= 0x1affe) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(grapheme) {
  if (!grapheme) {
    return 0;
  }
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(grapheme)) {
    return 2;
  }

  let sawPrintable = false;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null || isZeroWidthCodePoint(codePoint)) {
      continue;
    }
    if (isFullWidthCodePoint(codePoint)) {
      return 2;
    }
    sawPrintable = true;
  }
  return sawPrintable ? 1 : 0;
}

function padRight(value, width) {
  const pad = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(pad)}`;
}

function wrapWords(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (visibleLength(next) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

function box(title, lines) {
  const innerWidth = Math.max(54, Math.min(columns - 4, 78));
  const totalWidth = innerWidth + 4;
  const borderWidth = totalWidth - 2;
  const titleSegment = `─ ${title} `;
  const titleFillWidth = Math.max(0, borderWidth - visibleLength(titleSegment));
  const top = `╭${titleSegment}${"─".repeat(titleFillWidth)}╮`;
  const bottom = `╰${"─".repeat(borderWidth)}╯`;
  const body = lines.flatMap((line) => {
    if (line === "") {
      return [`│ ${" ".repeat(innerWidth)} │`];
    }
    return wrapWords(line, innerWidth).map((wrapped) => {
      return `│ ${padRight(wrapped, innerWidth)} │`;
    });
  });
  return [top, ...body, bottom].join("\n");
}

function metadataBlock() {
  const rows = [
    ["Package", PACKAGE_LABEL],
    ["Type", "plugin"],
    ["Requires", "OpenClaw >=2026.3.26"],
    ["ClawHub", osc8("view plugin", LINKS.plugin)],
  ];
  return rows.map(([label, value]) => `  ${dim(padRight(label, 9))} ${value}`).join("\n");
}

function rawLinksBlock(kind) {
  if (!showRawLinks) {
    return "";
  }
  const pluginOnly = ["", dim("Links:"), `  Plugin           ${LINKS.plugin}`];
  if (kind === "plugin-only") {
    return pluginOnly.join("\n");
  }
  return [
    ...pluginOnly,
    `  Security scan    ${LINKS.clawscan}`,
    `  Static analysis  ${LINKS.staticAnalysis}`,
    `  VirusTotal       ${LINKS.virustotal}`,
  ].join("\n");
}

function malicious() {
  const title = red("BLOCKED - ClawHub flagged this release as malicious");
  const scan = osc8(red("malicious"), LINKS.clawscan);
  const staticAnalysis = osc8(red("malicious behavior detected"), LINKS.staticAnalysis);
  const lines = [
    `• Security scan:     ${scan}`,
    `• Scanner:           ${osc8("malicious behavior detected", LINKS.clawscan)}`,
    `• Static analysis:   ${staticAnalysis}`,
    "",
    "OpenClaw will not install this release from ClawHub.",
    "Choose a different version, review the ClawHub security details, or contact the package maintainer if you believe this is wrong.",
  ];
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    box(title, lines),
    rawLinksBlock("security"),
  ].join("\n");
}

function blocked() {
  const title = red("BLOCKED - ClawHub blocked this release");
  const lines = [
    `• Security scan:     ${osc8("clean", LINKS.clawscan)}`,
    "• Finding:           Download disabled by ClawHub for this release",
    "",
    "OpenClaw will not install this release from ClawHub.",
    "Choose a different version, review the ClawHub security details, or contact the package maintainer if you believe this is wrong.",
  ];
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    box(title, lines),
    rawLinksBlock("security"),
  ].join("\n");
}

function suspicious() {
  const title = yellow("REVIEW REQUIRED - ClawHub flagged this release for security review");
  const lines = [
    `• Security scan:     ${osc8(yellow("suspicious"), LINKS.clawscan)}`,
    `• Finding:           ${osc8("suspicious payload strings", LINKS.staticAnalysis)}`,
    "",
    "Installing runs code on this machine and can access OpenClaw data, credentials, tools, and connected services.",
    "Review the ClawHub security details before installing.",
  ];
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    box(title, lines),
    rawLinksBlock("security"),
    "",
    "To install anyway, type the package name:",
    `  ${PACKAGE_NAME}`,
    "> _",
  ].join("\n");
}

function pending() {
  const title = yellow("REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check");
  const lines = [
    `• Security scan:     ${osc8(yellow("pending"), LINKS.clawscan)}`,
    "• Status:            scan not complete",
    "",
    "This does not mean the plugin is malicious, but ClawHub has not completed a clean security check for this release yet.",
    "Review the ClawHub security details before installing.",
  ];
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    box(title, lines),
    rawLinksBlock("security"),
    "",
    `Install ${PACKAGE_LABEL}? [y/N] _`,
  ].join("\n");
}

function clean() {
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    `Installing ${PACKAGE_LABEL} from ClawHub…`,
  ].join("\n");
}

switch (scenario) {
  case "malicious":
    console.log(malicious());
    break;
  case "blocked":
    console.log(blocked());
    break;
  case "pending":
  case "stale":
    console.log(pending());
    break;
  case "clean":
  case "community":
    console.log(clean());
    break;
  case "suspicious":
  case "review":
    console.log(suspicious());
    break;
  default:
    console.error(
      "Usage: node scripts/dev/clawhub-warning-demo.mjs [clean|pending|suspicious|malicious|blocked] [--plain|--raw-links-only]",
    );
    process.exitCode = 2;
}
