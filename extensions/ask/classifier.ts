import type { AskOption, AskUiType } from "./types.js";

const GO_STOP_OPTIONS: AskOption[] = [
  { label: "GO", value: "go" },
  { label: "STOP", value: "stop" },
];

const YES_NO_OPTIONS: AskOption[] = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

export type AskClassification = {
  mode: "single" | "grill";
  uiType: AskUiType;
  questionText: string;
  options: AskOption[];
};

export function classifyAskInput(rawArgs: string | undefined): AskClassification {
  const args = (rawArgs ?? "").trim();
  if (!args) {
    return {
      mode: "single",
      uiType: "modal",
      questionText: "What should I ask?",
      options: [],
    };
  }

  const grill = parseGrillArgs(args);
  if (grill.isGrill) {
    return {
      mode: "grill",
      uiType: "modal",
      questionText: grill.initialRequest,
      options: [],
    };
  }

  const explicit = parseExplicitOptions(args);
  const questionText = explicit.questionText || args;
  const lower = questionText.toLowerCase();
  const options = explicit.options.length > 0 ? explicit.options : inferOptions(questionText);

  if (shouldUseModal(lower, options)) {
    return { mode: "single", uiType: "modal", questionText, options: [] };
  }
  if (shouldUseSelect(lower, options)) {
    return {
      mode: "single",
      uiType: "select",
      questionText,
      options: normalizeOptions(options).slice(0, 25),
    };
  }
  return {
    mode: "single",
    uiType: "button",
    questionText,
    options: normalizeOptions(options).slice(0, 5),
  };
}

function parseGrillArgs(args: string): { isGrill: boolean; initialRequest: string } {
  const match = /^grill(?:\s+|$)([\s\S]*)$/iu.exec(args);
  if (!match) {
    return { isGrill: false, initialRequest: args };
  }
  const initialRequest = (match[1] ?? "").trim() || "未指定の依頼";
  return { isGrill: true, initialRequest };
}

function parseExplicitOptions(args: string): { questionText: string; options: AskOption[] } {
  const markerMatch = /(?:^|\s)--options(?:=|\s+)(.+)$/iu.exec(args);
  if (!markerMatch?.[1]) {
    return { questionText: args, options: [] };
  }
  const optionText = markerMatch[1].trim();
  const questionText = args.slice(0, markerMatch.index).trim();
  return { questionText, options: splitOptionText(optionText) };
}

function inferOptions(text: string): AskOption[] {
  const lower = text.toLowerCase();
  if (/\b(go|approve|approval|承認)\b|go\s*\/\s*stop|実装go|進めていい/u.test(lower)) {
    return GO_STOP_OPTIONS;
  }
  if (/\byes\s*\/\s*no\b|\b(y\/n)\b|はい\s*\/\s*いいえ/u.test(lower)) {
    return YES_NO_OPTIONS;
  }
  const slashOptions = extractSlashOptions(text);
  if (slashOptions.length >= 2) {
    return slashOptions;
  }
  return GO_STOP_OPTIONS;
}

function extractSlashOptions(text: string): AskOption[] {
  const compact = text.replace(/[？?。.!！].*$/u, "");
  const candidates = compact
    .split(/\s+(?:or|か|または)\s+|\s*\/\s*|\s*[、,]\s*/iu)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 30);
  if (candidates.length < 2 || candidates.length > 25) {
    return [];
  }
  const tail = candidates.slice(-Math.min(candidates.length, 5));
  if (tail.length < 2) {
    return [];
  }
  return tail.map((label) => ({ label, value: slugifyOption(label) }));
}

function splitOptionText(text: string): AskOption[] {
  return text
    .split(/\s*[,|/]\s*|\n+/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 25)
    .map((entry) => {
      const [labelRaw, valueRaw] = entry.split(/\s*:\s*/u, 2);
      const label = (labelRaw ?? entry).trim();
      const value = (valueRaw ?? slugifyOption(label)).trim();
      return { label, value };
    });
}

function normalizeOptions(options: AskOption[]): AskOption[] {
  const seen = new Set<string>();
  const normalized: AskOption[] = [];
  for (const option of options) {
    const label = option.label.trim().slice(0, 80);
    const value = (option.value.trim() || slugifyOption(label)).slice(0, 100);
    if (!label || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push({ label, value });
  }
  return normalized.length >= 2 ? normalized : GO_STOP_OPTIONS;
}

function shouldUseModal(lower: string, options: AskOption[]): boolean {
  if (
    /理由|違和感|補足|詳細|説明|入力|書いて|自由記述|why|reason|detail|describe|comment/u.test(
      lower,
    )
  ) {
    return true;
  }
  return options.length === 0;
}

function shouldUseSelect(lower: string, options: AskOption[]): boolean {
  if (options.length > 5) {
    return true;
  }
  return /候補|一覧|カテゴリ|方向性|スタイル|選んで|選択|choose|select|category|style/u.test(lower);
}

function slugifyOption(label: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (ascii) {
    return ascii;
  }
  const codePoints = Array.from(label)
    .map((char) => char.codePointAt(0)?.toString(36) ?? "x")
    .join("-")
    .slice(0, 80);
  return `option-${codePoints || "value"}`;
}
