package ai.openclaw.app.voice

import ai.openclaw.mobile.core.TalkDirective as SharedTalkDirective
import ai.openclaw.mobile.core.TalkDirectiveParseResult as SharedTalkDirectiveParseResult
import ai.openclaw.mobile.core.TalkDirectiveParser as SharedTalkDirectiveParser

typealias TalkDirective = SharedTalkDirective
typealias TalkDirectiveParseResult = SharedTalkDirectiveParseResult

object TalkDirectiveParser {
  /** Parses optional first-line JSON directives while preserving normal speech text. */
  fun parse(text: String): TalkDirectiveParseResult = SharedTalkDirectiveParser.parse(text)
}
