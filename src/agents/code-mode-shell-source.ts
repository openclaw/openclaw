/**
 * Detect shell-shaped strings wrongly passed to code-mode exec.
 *
 * Code-mode `exec` evaluates JavaScript/TypeScript. The `command` field is only
 * a source alias for hook compatibility. Local models often pass bash (`ls`,
 * `/bin/ls`, `sh -c …`) and then retry through QuickJS SyntaxError/ReferenceError
 * storms. Reject those before the guest runs so the model gets an actionable
 * invalid_input instead of opaque parse noise.
 */

// ESM `export …` is a JS marker; bare shell `export FOO=1` must still hit SHELL_HEAD.
const JS_MARKERS =
  /\b(?:await|return|typeof|new)\s+|\b(?:const|let|var|function|class|import)\s+[A-Za-z_$*{]|\bexport\s+(?:(?:const|let|var|function|async|default|type|interface|enum|declare|namespace)\b|\{|\*)|\b(?:tools\.|ALL_TOOLS|API\.|namespaces\.)|=>/;

const SHELL_HEAD =
  /^(?:(?:\/(?:usr\/)?bin\/)?(?:ls|pwd|echo|cat|find|dir|sh|bash|zsh|head|tail|mkdir|rm|cp|mv|chmod|curl|wget|which|env|export|cd|true|false|printf|test|stat|file|grep|sed|awk|xargs|tee|touch|ln|python|python3|node|ruby|perl)\b)/;

const SHELL_WRAPPER = /^(?:(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh))\s+-c\b/;

const SHELL_PATH_BIN = /^\/(?:bin|usr\/bin|usr\/local\/bin)\//;

/** True when source looks like a shell command rather than JS/TS guest code. */
export function isShellLikeCodeModeSource(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) {
    return false;
  }
  if (JS_MARKERS.test(trimmed)) {
    return false;
  }
  if (SHELL_WRAPPER.test(trimmed) || SHELL_PATH_BIN.test(trimmed) || SHELL_HEAD.test(trimmed)) {
    return true;
  }
  // Compact shell pipelines / redirects without JS markers (observed keep-trying storms).
  // Tradeoff: keyword-free JS one-liners like `a || b` can false-positive; realistic guest
  // programs almost always include return/const/await/tools markers first.
  if (
    trimmed.length <= 240 &&
    !trimmed.includes("\n") &&
    /(?:\|\||&&|\||>>?|2>&1|\$\()/.test(trimmed) &&
    /^[a-zA-Z0-9_./'"\s\\|;<>&$()-]+$/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

export const CODE_MODE_SHELL_SOURCE_ERROR =
  "code-mode exec runs JavaScript or TypeScript, not shell. Received what looks like a shell command. Pass JS/TS in `code` (or a matching `command` alias) that uses ALL_TOOLS / tools.search / tools.callValue to call catalog tools. Do not pass bash/ls/pwd/echo strings, and do not retry the same failed shell-shaped payload.";
