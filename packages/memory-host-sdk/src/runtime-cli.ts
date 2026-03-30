// Focused runtime contract for memory CLI/UI helpers.

export { formatErrorMessage, withManager } from "../../../src/cli/cli-utils.js";
export { resolveCommandSecretRefsViaGateway } from "../../../src/cli/command-secret-gateway.js";
export { formatHelpExamples } from "../../../src/cli/help-format.js";
export { withProgress, withProgressTotals } from "../../../src/cli/progress.js";
export { isVerbose, setVerbose } from "../../../src/globals.js";
export { defaultRuntime } from "../../../src/runtime.js";
export { formatDocsLink } from "../../../src/terminal/links.js";
export { colorize, isRich, theme } from "../../../src/terminal/theme.js";
export { shortenHomeInString, shortenHomePath } from "../../../src/utils.js";
