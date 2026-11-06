package ai.openclaw.app.ui.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import java.util.Locale

// Above these bounds tokenizing costs more than highlighting is worth on re-renders; render plain.
// The char cap also covers huge minified one-line payloads the line cap would miss.
internal const val CODE_HIGHLIGHT_MAX_LINES = 200
internal const val CODE_HIGHLIGHT_MAX_CHARS = 20_000

internal enum class CodeTokenKind { KEYWORD, STRING, COMMENT, NUMBER }

internal data class CodeToken(
  val start: Int,
  val end: Int,
  val kind: CodeTokenKind,
)

/** Theme-derived token colors so highlighting follows the active light/dark palette. */
internal data class CodeTokenColors(
  val keyword: Color,
  val string: Color,
  val comment: Color,
  val number: Color,
)

private data class CodeLanguageSpec(
  val keywords: Set<String>,
  val lineComment: String? = null,
  // Bash-only quirks: '#' opens a comment only at a word boundary (parameter expansions
  // like ${#items[@]} contain '#'), and single-quoted strings have no backslash escapes.
  val lineCommentNeedsBoundary: Boolean = false,
  val blockComment: Pair<String, String>? = null,
  // Kotlin/Swift block comments nest; scanning must track depth or the outer tail leaks as code.
  val nestedBlockComments: Boolean = false,
  val quoteChars: Set<Char>,
  val tripleQuotes: Boolean = false,
  // Kotlin raw triple strings do not process backslashes; Python and Swift do.
  val tripleQuoteEscapes: Boolean = true,
  val singleQuoteEscapes: Boolean = true,
  // Shell strings span newlines; most other languages terminate ordinary quotes at end of line.
  val multilineStrings: Boolean = false,
)

private val kotlinSpec =
  CodeLanguageSpec(
    keywords =
      setOf(
        "as",
        "break",
        "by",
        "catch",
        "class",
        "companion",
        "constructor",
        "continue",
        "data",
        "do",
        "else",
        "enum",
        "false",
        "finally",
        "for",
        "fun",
        "if",
        "import",
        "in",
        "init",
        "interface",
        "internal",
        "is",
        "lateinit",
        "null",
        "object",
        "override",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "sealed",
        "super",
        "suspend",
        "this",
        "throw",
        "true",
        "try",
        "typealias",
        "val",
        "var",
        "when",
        "while",
      ),
    lineComment = "//",
    blockComment = "/*" to "*/",
    nestedBlockComments = true,
    quoteChars = setOf('"'),
    tripleQuotes = true,
    tripleQuoteEscapes = false,
  )

private val swiftSpec =
  CodeLanguageSpec(
    keywords =
      setOf(
        "actor",
        "as",
        "associatedtype",
        "async",
        "await",
        "break",
        "case",
        "catch",
        "class",
        "continue",
        "default",
        "defer",
        "deinit",
        "do",
        "else",
        "enum",
        "extension",
        "fallthrough",
        "false",
        "fileprivate",
        "for",
        "func",
        "guard",
        "if",
        "import",
        "in",
        "init",
        "internal",
        "is",
        "let",
        "mutating",
        "nil",
        "open",
        "override",
        "private",
        "protocol",
        "public",
        "repeat",
        "return",
        "self",
        "some",
        "static",
        "struct",
        "super",
        "switch",
        "throw",
        "throws",
        "true",
        "try",
        "typealias",
        "var",
        "where",
        "while",
      ),
    lineComment = "//",
    blockComment = "/*" to "*/",
    nestedBlockComments = true,
    quoteChars = setOf('"'),
    tripleQuotes = true,
  )

private val typescriptSpec =
  CodeLanguageSpec(
    keywords =
      setOf(
        "abstract",
        "any",
        "as",
        "async",
        "await",
        "boolean",
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "declare",
        "default",
        "delete",
        "do",
        "else",
        "enum",
        "export",
        "extends",
        "false",
        "finally",
        "for",
        "from",
        "function",
        "if",
        "implements",
        "import",
        "in",
        "instanceof",
        "interface",
        "let",
        "namespace",
        "never",
        "new",
        "null",
        "number",
        "of",
        "readonly",
        "return",
        "static",
        "string",
        "super",
        "switch",
        "this",
        "throw",
        "true",
        "try",
        "type",
        "typeof",
        "undefined",
        "unknown",
        "var",
        "void",
        "while",
        "yield",
      ),
    lineComment = "//",
    blockComment = "/*" to "*/",
    quoteChars = setOf('"', '\'', '`'),
  )

private val pythonSpec =
  CodeLanguageSpec(
    keywords =
      setOf(
        "and",
        "as",
        "assert",
        "async",
        "await",
        "break",
        "case",
        "class",
        "continue",
        "def",
        "del",
        "elif",
        "else",
        "except",
        "finally",
        "for",
        "from",
        "global",
        "if",
        "import",
        "in",
        "is",
        "lambda",
        "match",
        "nonlocal",
        "not",
        "or",
        "pass",
        "raise",
        "return",
        "try",
        "while",
        "with",
        "yield",
        "False",
        "None",
        "True",
      ),
    lineComment = "#",
    quoteChars = setOf('"', '\''),
    tripleQuotes = true,
  )

private val bashSpec =
  CodeLanguageSpec(
    keywords =
      setOf(
        "break",
        "case",
        "continue",
        "declare",
        "do",
        "done",
        "elif",
        "else",
        "esac",
        "exit",
        "export",
        "fi",
        "for",
        "function",
        "if",
        "in",
        "local",
        "readonly",
        "return",
        "select",
        "set",
        "shift",
        "source",
        "then",
        "unset",
        "until",
        "while",
      ),
    lineComment = "#",
    lineCommentNeedsBoundary = true,
    quoteChars = setOf('"', '\''),
    singleQuoteEscapes = false,
    multilineStrings = true,
  )

private val jsonSpec =
  CodeLanguageSpec(
    keywords = setOf("false", "null", "true"),
    quoteChars = setOf('"'),
  )

private val codeLanguageSpecs: Map<String, CodeLanguageSpec> =
  mapOf(
    "kotlin" to kotlinSpec,
    "kt" to kotlinSpec,
    "kts" to kotlinSpec,
    "swift" to swiftSpec,
    "typescript" to typescriptSpec,
    "ts" to typescriptSpec,
    "tsx" to typescriptSpec,
    "javascript" to typescriptSpec,
    "js" to typescriptSpec,
    "jsx" to typescriptSpec,
    "python" to pythonSpec,
    "py" to pythonSpec,
    "bash" to bashSpec,
    "sh" to bashSpec,
    "shell" to bashSpec,
    "zsh" to bashSpec,
    "json" to jsonSpec,
  )

/**
 * Tokenizes fenced-code content into keyword/string/comment/number spans.
 * Unknown/absent languages and blocks over [CODE_HIGHLIGHT_MAX_LINES] return no
 * tokens so callers fall back to the plain monospace rendering.
 */
internal fun codeHighlightTokens(
  code: String,
  language: String?,
): List<CodeToken> {
  // Fence info strings can carry attributes ("kotlin linenums"); only the first word names the language.
  val key =
    language
      ?.trim()
      ?.substringBefore(' ')
      ?.lowercase(Locale.US)
      .orEmpty()
  val spec = codeLanguageSpecs[key] ?: return emptyList()
  if (code.length > CODE_HIGHLIGHT_MAX_CHARS) return emptyList()
  // Fenced literals keep a trailing newline; count logical lines so an exactly-200-line block still highlights.
  val newlines = code.count { it == '\n' }
  val lineCount = if (code.isEmpty() || code.endsWith("\n")) newlines else newlines + 1
  if (lineCount > CODE_HIGHLIGHT_MAX_LINES) return emptyList()

  val tokens = mutableListOf<CodeToken>()
  var i = 0
  while (i < code.length) {
    val c = code[i]
    val lineComment = spec.lineComment
    val blockComment = spec.blockComment
    // Shell comments open at word boundaries: start, whitespace, or after control operators.
    // '{' is deliberately not a boundary so ${#items[@]} expansions stay code.
    val prev = if (i == 0) ' ' else code[i - 1]
    val atCommentBoundary = !spec.lineCommentNeedsBoundary || prev.isWhitespace() || prev in ";&|()"
    var end = i + 1
    val kind =
      when {
        lineComment != null && atCommentBoundary && code.startsWith(lineComment, i) -> {
          end = code.indexOf('\n', i).let { if (it == -1) code.length else it }
          CodeTokenKind.COMMENT
        }

        blockComment != null && code.startsWith(blockComment.first, i) -> {
          end = scanBlockComment(code, i, blockComment, spec.nestedBlockComments)
          CodeTokenKind.COMMENT
        }

        c in spec.quoteChars -> {
          end = scanString(code, i, spec)
          CodeTokenKind.STRING
        }

        c.isLetterOrDigit() || c == '_' -> {
          val number = c.isDigit()
          // Consume the whole identifier so "value1" cannot start a number mid-word.
          while (end < code.length && (code[end].isLetterOrDigit() || code[end] == '_' || (number && code[end] == '.'))) end++
          when {
            number -> CodeTokenKind.NUMBER
            code.substring(i, end) in spec.keywords -> CodeTokenKind.KEYWORD
            else -> null
          }
        }

        else -> {
          null
        }
      }
    if (kind != null) tokens.add(CodeToken(i, end, kind))
    i = end
  }
  return tokens
}

private fun scanBlockComment(
  code: String,
  start: Int,
  delimiters: Pair<String, String>,
  nested: Boolean,
): Int {
  val (open, close) = delimiters
  var depth = 1
  var i = start + open.length
  while (i < code.length) {
    when {
      code.startsWith(close, i) -> {
        depth--
        i += close.length
        if (depth == 0) return i
      }

      nested && code.startsWith(open, i) -> {
        depth++
        i += open.length
      }

      else -> {
        i++
      }
    }
  }
  return code.length
}

private fun scanString(
  code: String,
  start: Int,
  spec: CodeLanguageSpec,
): Int {
  val quote = code[start]
  val triple = spec.tripleQuotes && code.startsWith("$quote$quote$quote", start)
  val delimiter = if (triple) "$quote$quote$quote" else quote.toString()
  val escapes = if (triple) spec.tripleQuoteEscapes else spec.singleQuoteEscapes || quote != '\''
  val multiline = triple || quote == '`' || spec.multilineStrings
  var i = start + delimiter.length
  while (i < code.length) {
    if (code.startsWith(delimiter, i)) return i + delimiter.length
    if (!multiline && code[i] == '\n') return i
    i += if (escapes && code[i] == '\\') 2 else 1
  }
  return code.length
}

/** Builds the display string for a code block, plain when no tokens apply. */
internal fun buildHighlightedCode(
  code: String,
  language: String?,
  colors: CodeTokenColors,
): AnnotatedString {
  val tokens = codeHighlightTokens(code, language)
  if (tokens.isEmpty()) return AnnotatedString(code)
  return buildAnnotatedString {
    append(code)
    for (token in tokens) {
      addStyle(spanStyleFor(token.kind, colors), token.start, token.end)
    }
  }
}

private fun spanStyleFor(
  kind: CodeTokenKind,
  colors: CodeTokenColors,
): SpanStyle =
  when (kind) {
    CodeTokenKind.KEYWORD -> SpanStyle(color = colors.keyword)
    CodeTokenKind.STRING -> SpanStyle(color = colors.string)
    CodeTokenKind.COMMENT -> SpanStyle(color = colors.comment, fontStyle = FontStyle.Italic)
    CodeTokenKind.NUMBER -> SpanStyle(color = colors.number)
  }
