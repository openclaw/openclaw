package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatToolActivity

/** A presentation-only bridge: history remains the owner of output and reconnect recovery. */
internal class LiveToolActivityBridge {
  private var scope: String? = null
  private val calls = linkedMapOf<String, ChatPendingToolCall>()

  fun update(
    toolScope: String,
    live: List<ChatPendingToolCall>,
  ): List<ChatPendingToolCall> {
    if (scope != toolScope) {
      calls.clear()
      scope = toolScope
    }
    val current = live.associateBy { it.presentationKey() }
    // A terminal event can precede the history response. Keep the row, but never keep
    // claiming that a retired call is running. The next turn/session invalidates it.
    calls.replaceAll { key, call ->
      current[key] ?: call.copy(
        isComplete = true,
        activity =
          call.activity?.let {
            if (it.status == "running") it.copy(phase = "end", status = null) else it
          },
      )
    }
    live.sortedBy { it.startedAtMs }.forEach { calls[it.presentationKey()] = it }
    return calls.values.toList()
  }
}

private fun ChatPendingToolCall.presentationKey(): String = presentationId ?: "${runId.orEmpty()}:$toolCallId"

/** Merge only presentation, after completed-work selection; do not rewrite transcript data. */
internal fun projectToolActivity(
  items: List<ChatTimelineItem>,
  history: List<ChatTimelineItem>,
  live: List<ChatPendingToolCall>,
  toolScope: String,
  toolScopesByRun: Map<String, String>,
): List<ChatTimelineItem> {
  val groups = linkedMapOf<String, ChatTimelineItem.ToolActivity>()
  // Timeline order is reversed. Preserve invocation order within each disclosure.
  items.asReversed().filterIsInstance<ChatTimelineItem.ToolActivity>().forEach { group ->
    val previous = groups[group.disclosureKey]
    groups[group.disclosureKey] =
      if (previous == null) {
        group
      } else {
        previous.copy(
          tools = previous.tools + group.tools,
          toolKeys = previous.toolKeys + group.toolKeys,
          knownRunIds = previous.knownRunIds + group.knownRunIds,
          settledToolKeys = previous.settledToolKeys + group.settledToolKeys,
        )
      }
  }
  val durable = history.filterIsInstance<ChatTimelineItem.ToolActivity>()
  live.sortedBy { it.startedAtMs }.forEach { call ->
    val scope = call.runId?.let(toolScopesByRun::get) ?: toolScope
    val matches =
      durable.filter { it.disclosureKey == scope }.flatMap { group ->
        group.tools.mapIndexedNotNull { index, tool ->
          group.toolKeys[index].takeIf {
            tool.toolCallId == call.toolCallId &&
              (call.runId == null || it.startsWith(":") || it.startsWith("${call.runId}:"))
          }
        }
      }
    val key = matches.singleOrNull() ?: call.presentationKey()
    // A row folded under Worked belongs there, not in a duplicate live disclosure.
    val visible = groups[scope]
    val folded = matches.size == 1 && visible?.toolKeys?.contains(key) != true
    val alert = call.isError == true || call.activity?.status in setOf("blocked", "failed")
    if (folded && !alert) return@forEach
    val hiddenOwner = if (folded) durable.singleOrNull { it.disclosureKey == scope && key in it.toolKeys } else null
    val group =
      visible ?: hiddenOwner?.let { owner ->
        val index = owner.toolKeys.indexOf(key)
        owner.copy(tools = listOf(owner.tools[index]), toolKeys = listOf(key))
      } ?: ChatTimelineItem.ToolActivity(scope, emptyList(), disclosureKey = scope)
    var index = group.toolKeys.indexOf(key)
    val tools = group.tools.toMutableList()
    val toolKeys = group.toolKeys.toMutableList()
    if (index < 0) {
      tools.add(hiddenOwner?.let { it.tools[it.toolKeys.indexOf(key)] } ?: ChatToolActivity(call.toolCallId, call.name, null, null, call.isError == true, call.args, call.activity, true))
      toolKeys.add(key)
      index = tools.lastIndex
    }
    run {
      val tool = tools[index]
      tools[index] =
        tool.copy(
          arguments = tool.arguments ?: call.args,
          isError = tool.isError || call.isError == true,
          activity =
            if (call.activity?.status in setOf("blocked", "failed")) {
              call.activity
            } else if (tool.activityPrepared) {
              tool.activity
            } else {
              call.activity ?: tool.activity
            },
        )
    }
    groups[scope] = group.copy(tools = tools, toolKeys = toolKeys, liveTools = group.liveTools + (key to if (key in group.settledToolKeys) call.copy(isComplete = true) else call))
  }
  groups.replaceAll { _, group ->
    val order = group.tools.indices.toMutableList()
    val positions = order.filter { group.toolKeys[it] in group.liveTools }
    val byStart = positions.sortedBy { group.liveTools.getValue(group.toolKeys[it]).startedAtMs }
    positions.forEachIndexed { index, position -> order[position] = byStart[index] }
    group.copy(tools = order.map { group.tools[it] }, toolKeys = order.map { group.toolKeys[it] })
  }
  val emitted = mutableSetOf<String>()
  val visibleScopes = items.filterIsInstance<ChatTimelineItem.ToolActivity>().map { it.disclosureKey }.toSet()
  val anchors = items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.toolScopeKey() }.toSet()
  val edgeScopes = groups.keys.filter { it !in visibleScopes && (it == toolScope || it !in anchors) }
  val prefix = items.takeWhile { it is ChatTimelineItem.StreamingAssistant || it is ChatTimelineItem.QuestionPrompt || it is ChatTimelineItem.OutboxCommand || it is ChatTimelineItem.RecoveryOutboxCommand || it is ChatTimelineItem.OutboxRecoveryHeader }
  return buildList {
    addAll(prefix)
    edgeScopes.forEach { scope ->
      add(groups.getValue(scope))
      emitted.add(scope)
    }
    items.drop(prefix.size).forEach { item ->
      if (item is ChatTimelineItem.Message) {
        val scope = item.message.toolScopeKey()
        if (scope in groups && scope !in visibleScopes && emitted.add(scope)) add(groups.getValue(scope))
      }
      if (item is ChatTimelineItem.ToolActivity) {
        if (emitted.add(item.disclosureKey)) add(groups.getValue(item.disclosureKey))
      } else {
        add(item)
      }
    }
  }
}
