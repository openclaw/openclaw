/**
 * Heuristic detection of "programming/coding" intent from user prompt.
 * Used to optionally switch to a code-focused model (e.g. qwen-portal/coder-model)
 * when agents.defaults.model.codePrimary is set.
 */

const CODE_INTENT_PATTERNS = [
  // Chinese (no \b; word boundary does not work for CJK)
  /(写|写个|写一段|实现|写一)(段|个)?(代码|程序|脚本|函数|方法)/,
  /(修|改|调)(bug|错误|代码)/,
  /(编程|写代码|敲代码|打代码)/,
  /(代码|程序|脚本)(实现|写|生成|补全)/,
  /(函数|方法|类)(实现|写|定义)/,
  /(实现|写)(一个)?(方法|函数)/,
  /(debug|调试|排错)/,
  // English / mixed
  /\b(write|implement|create|add)\s+(a\s+)?(function|method|class|script|code)\b/i,
  /\b(code|programming|coding)\s+(task|request|help|please)\b/i,
  /\b(implement|fix|refactor)\s+(the\s+)?(code|function)\b/i,
  /\b(how\s+to\s+)?(implement|write)\s+.*\s+in\s+(python|js|typescript|java|rust|go)\b/i,
  // File extensions (strong signal)
  /\b\w+\.(py|ts|tsx|js|jsx|java|rs|go|rb|php|cpp|c|h|kt|swift)\b/,
  // Code block or "snippet"
  /```[\s\S]*?```/,
  /\b(snippet|snippet of code|code block)\b/i,
];

/** Max length to scan; avoid scanning huge pastes. */
const MAX_SCAN_LENGTH = 4000;

/**
 * Returns true if the prompt likely indicates a programming/coding request.
 * Used only when codePrimary is configured; does not run when disabled.
 */
export function isCodeIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  const slice = trimmed.length > MAX_SCAN_LENGTH ? trimmed.slice(0, MAX_SCAN_LENGTH) : trimmed;
  return CODE_INTENT_PATTERNS.some((re) => re.test(slice));
}
