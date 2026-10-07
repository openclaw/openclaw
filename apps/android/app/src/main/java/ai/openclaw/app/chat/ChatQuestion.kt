package ai.openclaw.app.chat

import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionRecord

enum class ChatQuestionStatus {
  Pending,
  Submitting,
  Answered,
  AnsweredElsewhere,
  Expired,
  Cancelled,
  Unavailable,
}

data class ChatQuestionPrompt(
  val record: QuestionRecord,
  val submitting: Boolean = false,
  val skipping: Boolean = false,
  val answeredLocally: Boolean = false,
  val errorText: String? = null,
  val terminalObservedAtMs: Long? = null,
  val recoveryUnavailable: Boolean = false,
  // Process-only input can contain secrets; it must not enter saved or persisted state.
  val draft: ChatQuestionDraft = if (record.status == "pending") ChatQuestionDraft.fromQuestions(record.questions) else ChatQuestionDraft(),
  internal val promptOwner: Any = Any(),
) {
  fun status(nowMs: Long = System.currentTimeMillis()): ChatQuestionStatus =
    when {
      recoveryUnavailable -> ChatQuestionStatus.Unavailable
      record.status == "answered" -> if (answeredLocally) ChatQuestionStatus.Answered else ChatQuestionStatus.AnsweredElsewhere
      record.status == "cancelled" -> ChatQuestionStatus.Cancelled
      record.status == "expired" || nowMs >= record.expiresAtMs -> ChatQuestionStatus.Expired
      submitting -> ChatQuestionStatus.Submitting
      else -> ChatQuestionStatus.Pending
    }
}

data class ChatQuestionDraft(
  val selectedOptions: Map<String, Set<String>> = emptyMap(),
  val otherText: Map<String, String> = emptyMap(),
  val secretStoreAllowedHostsText: String? = null,
) {
  companion object {
    fun fromQuestions(questions: List<Question>): ChatQuestionDraft {
      val selected = mutableMapOf<String, Set<String>>()
      val text = mutableMapOf<String, String>()
      for (question in questions) {
        if (question.isSecret == true) continue
        val defaults = question.defaultAnswers ?: continue
        val values = question.options.map { it.value ?: it.label }.toSet()
        selected[question.questionId] = defaults.filter { it in values }.toSet()
        text[question.questionId] = defaults.filter { it !in values }.joinToString(if (question.answerFormat == "lines") "\n" else "")
      }
      return ChatQuestionDraft(selectedOptions = selected, otherText = text)
    }
  }

  fun secretStoreAllowedHosts(questions: List<Question>): List<String>? {
    val store = questions.firstOrNull()?.secretStore?.takeIf { it.kind == "secret" } ?: return null
    return secretStoreAllowedHostsText?.split(Regex("[,\\s]+"))?.filter { it.isNotEmpty() } ?: store.allowedHosts.orEmpty()
  }

  fun toggle(
    question: Question,
    value: String,
  ): ChatQuestionDraft {
    if (question.options.none { (it.value ?: it.label) == value }) return this
    val selected = selectedOptions[question.questionId].orEmpty()
    val next =
      if (question.multiSelect == true) {
        if (value in selected) selected - value else selected + value
      } else if (selected == setOf(value)) {
        emptySet()
      } else {
        setOf(value)
      }
    return copy(
      selectedOptions = selectedOptions + (question.questionId to next),
      otherText = if (question.multiSelect != true && next.isNotEmpty()) otherText + (question.questionId to "") else otherText,
    )
  }

  fun setOther(
    question: Question,
    value: String,
  ): ChatQuestionDraft {
    if (question.options.isNotEmpty() && question.isOther != true) return this
    val clearOptions = question.multiSelect != true && (if (question.isSecret == true || question.presentation == "form") value.isNotEmpty() else value.isNotBlank())
    return copy(
      selectedOptions = if (clearOptions) selectedOptions + (question.questionId to emptySet()) else selectedOptions,
      otherText = otherText + (question.questionId to value),
    )
  }

  fun answers(questions: List<Question>): Map<String, List<String>>? {
    val result = linkedMapOf<String, List<String>>()
    for (question in questions) {
      val selected = selectedOptions[question.questionId].orEmpty()
      val values = question.options.mapNotNull { option -> (option.value ?: option.label).takeIf { it in selected } }.toMutableList()
      val text = otherText[question.questionId]?.let { if (question.isSecret == true || question.presentation == "form") it else it.trim() }
      text?.takeIf { it.isNotEmpty() }?.let { value ->
        if (question.answerFormat == "lines") values.addAll(value.replace("\r\n", "\n").split('\n')) else values.add(value)
      }
      if (values.isEmpty() && question.allowEmpty != true) return null
      result[question.questionId] = values
    }
    return result
  }
}

internal fun questionsForSession(
  prompts: List<ChatQuestionPrompt>,
  sessionKey: String,
  mainSessionKey: String,
  activeAgentId: String,
): List<ChatQuestionPrompt> {
  val main = mainSessionKey.trim().ifEmpty { "main" }
  val current = sessionKey.trim().let { if (it == "main") main else it }
  val activeAgent = activeAgentId.trim().lowercase()
  return prompts.filter { prompt ->
    val key = prompt.record.sessionKey?.trim() ?: return@filter true
    val sessionMatches = key == sessionKey || key == current || (key == "main" && current == main)
    val promptAgent =
      prompt.record.agentId
        ?.trim()
        .orEmpty()
        .lowercase()
    sessionMatches && (promptAgent.isEmpty() || activeAgent.isEmpty() || promptAgent == activeAgent)
  }
}
