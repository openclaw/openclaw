package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayLoadedImage
import ai.openclaw.app.gateway.GatewaySourcePreviewConfig
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionRecord
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

internal object AndroidScreenshotFixture {
  @Volatile private var scene: AndroidScreenshotScene = AndroidScreenshotScene.Home

  fun configure(scene: AndroidScreenshotScene) {
    this.scene = scene
  }

  val branchesEnabled: Boolean get() = scene == AndroidScreenshotScene.Branches
  val attentionEnabled: Boolean get() = scene == AndroidScreenshotScene.Attention || scene == AndroidScreenshotScene.AttentionExpiry

  private val workScene: Boolean
    get() = scene in setOf(AndroidScreenshotScene.CompletedWork, AndroidScreenshotScene.ActiveWork, AndroidScreenshotScene.WorkBoundaries)

  const val gatewayId = "android-screenshot-gateway"
  const val controlUiBaseUrl = "http://127.0.0.1:18789"
  val mainSessionKey: String get() = if (workScene) "agent:main:node-work-proof" else "agent:main:node-screenshot"
  val sourcePreviewConfig: GatewaySourcePreviewConfig?
    get() = if (scene == AndroidScreenshotScene.Sources) GatewaySourcePreviewConfig(controlUiBaseUrl, "", "https://gateway.example", true, 0L) else null

  fun loadSourceFavicon(hostname: String): GatewayLoadedImage? {
    if (scene != AndroidScreenshotScene.Sources || hostname != "parks.example.org") return null
    val svg = """<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#30a86b"/><path d="M16 5 6 21h7v6h6v-6h7Z" fill="white"/></svg>"""
    return GatewayLoadedImage(svg.toByteArray(), "image/svg+xml")
  }

  const val primarySessionTitle = "Android release planning"
  const val cronJobId = "android-release-digest"
  const val cronJobName = "Android release digest"
  private val branchLeaves = (1..12).map { "android-screenshot-branch-${it.toString().padStart(2, '0')}" }

  fun createRequester(branchesEnabled: Boolean = this.branchesEnabled): (String, String?) -> String {
    val activeLeaf = AtomicReference(branchLeaves.first())
    // A runtime gets a fresh lifetime; list refreshes and scene re-entry keep its exact record.
    val pendingQuestion =
      System.currentTimeMillis().let { nowMs ->
        QuestionRecord(
          id = "android-screenshot-question",
          questions =
            listOf(
              Question(
                questionId = "release_note",
                header = "Release note",
                question = "What should the release note mention?",
                options = emptyList(),
              ),
            ),
          agentId = "main",
          sessionKey = mainSessionKey,
          createdAtMs = nowMs,
          expiresAtMs = nowMs + 600_000,
          status = "pending",
        )
      }
    val questionRecords =
      AtomicReference(
        if (attentionEnabled) {
          listOf(
            pendingQuestion.copy(id = "attention-question-1", sessionKey = "discord:android", createdAtMs = pendingQuestion.createdAtMs - 4000, questions = listOf(pendingQuestion.questions.first().copy(question = "Which Android version should we test first?"), pendingQuestion.questions.first().copy(questionId = "device", question = "Which screen size should we prioritize?"))),
            pendingQuestion.copy(id = "attention-question-2", sessionKey = "discord:android", createdAtMs = pendingQuestion.createdAtMs - 2000, questions = listOf(pendingQuestion.questions.first().copy(question = "Should the tablet layout ship with this change?"))),
          ).mapIndexed { index, question -> if (scene == AndroidScreenshotScene.AttentionExpiry) question.copy(expiresAtMs = System.currentTimeMillis() + 16000 - index * 4000) else question }
        } else {
          listOf(pendingQuestion)
        },
      )
    val approvals =
      AtomicReference(
        if (attentionEnabled) {
          GatewayApprovalKind.entries.mapIndexed { index, kind ->
            buildJsonObject {
              put("id", "attention-approval-$index")
              put("createdAtMs", pendingQuestion.createdAtMs - 3000 + index * 1000)
              put("expiresAtMs", System.currentTimeMillis() + if (scene == AndroidScreenshotScene.AttentionExpiry) 8000 + index * 4000 else 600000)
              put("urlPath", "/approve/attention-approval-$index")
              put("status", "pending")
              putJsonObject("presentation") {
                put("kind", kind.wireValue)
                put("agentId", "main")
                putJsonArray("allowedDecisions") {
                  add(JsonPrimitive("allow-once"))
                  add(JsonPrimitive("deny"))
                }
                if (kind == GatewayApprovalKind.Exec) {
                  put("commandText", "pnpm android:test:integration")
                } else {
                  put("title", if (kind == GatewayApprovalKind.Plugin) "Send the release summary" else "Update Gateway settings")
                  put("description", "Review the prepared change before continuing.")
                  if (kind == GatewayApprovalKind.Plugin) put("severity", "info") else put("proposalHash", "a".repeat(64))
                }
              }
            }
          }
        } else {
          emptyList()
        },
      )
    return { method, paramsJson ->
      when (method) {
        "health" -> {
          buildJsonObject { put("ok", JsonPrimitive(true)) }.toString()
        }

        "chat.history" -> {
          if (branchesEnabled) {
            branchRequestParams(paramsJson)
            branchHistory(activeLeaf.get())
          } else if (scene == AndroidScreenshotScene.Sources) {
            sourceHistory()
          } else if (workScene) {
            workHistory()
          } else {
            chatHistory()
          }
        }

        "sessions.list" -> {
          if (branchesEnabled) branchSessionList(paramsJson, activeLeaf.get()) else sessionList(paramsJson)
        }

        "sessions.branches.list" -> {
          check(branchesEnabled) { "Screenshot scene does not support sessions.branches.list" }
          branchRequestParams(paramsJson)
          branchList(activeLeaf.get())
        }

        "sessions.branches.switch" -> {
          check(branchesEnabled) { "Screenshot scene does not support sessions.branches.switch" }
          val params = branchRequestParams(paramsJson, switching = true)
          val leaf = params.getValue("leafEntryId").jsonPrimitive.content
          require(leaf in branchLeaves) { "Unknown screenshot branch leaf" }
          activeLeaf.set(leaf)
          "{}"
        }

        "chat.metadata" -> {
          chatMetadata()
        }

        "models.list" -> {
          modelCatalog()
        }

        "tasks.list" -> {
          backgroundTasks(paramsJson)
        }

        "tasks.get" -> {
          backgroundTask(paramsJson)
        }

        "question.list" -> {
          Json.encodeToString(QuestionListResult(if (workScene) emptyList() else questionRecords.get().filter { it.status == "pending" && it.expiresAtMs > System.currentTimeMillis() }))
        }

        "question.get" -> {
          val id =
            Json
              .parseToJsonElement(requireNotNull(paramsJson))
              .jsonObject
              .getValue("id")
              .jsonPrimitive.content
          val record = questionRecords.get().first { it.id == id }
          val terminal = if (record.expiresAtMs <= System.currentTimeMillis()) record.copy(status = "expired") else record
          """{"question":${Json.encodeToString(terminal)}}"""
        }

        "exec.approval.list", "plugin.approval.list", "openclaw.approval.list" -> {
          val kind = GatewayApprovalKind.entries.first { method == "${it.eventPrefix}.approval.list" }
          JsonArray(
            approvals.get().filter { it.getValue("status") == JsonPrimitive("pending") && it.getValue("presentation").jsonObject.getValue("kind") == JsonPrimitive(kind.wireValue) }.map { approval ->
              buildJsonObject {
                listOf("id", "createdAtMs", "expiresAtMs").forEach { put(it, approval.getValue(it)) }
                putJsonObject("request") {
                  put("sessionKey", "main")
                  put("agentId", "main")
                }
              }
            },
          ).toString()
        }

        "approval.get", "approval.resolve" -> {
          val params = Json.parseToJsonElement(requireNotNull(paramsJson)).jsonObject
          val id = params.getValue("id")
          val current = approvals.get().first { it.getValue("id") == id }
          val next = if (method == "approval.resolve") JsonObject(current + mapOf("status" to JsonPrimitive(if (params["decision"] == JsonPrimitive("deny")) "denied" else "allowed"), "decision" to params.getValue("decision"), "reason" to JsonPrimitive("user"), "resolvedAtMs" to JsonPrimitive(System.currentTimeMillis()))) else current
          if (method == "approval.resolve") approvals.updateAndGet { rows -> rows.map { if (it.getValue("id") == id) next else it } }
          buildJsonObject {
            put("approval", next)
            if (method == "approval.resolve") put("applied", true)
          }.toString()
        }

        "cron.list" -> {
          cronList()
        }

        "cron.get" -> {
          cronJob().toString()
        }

        "cron.runs" -> {
          cronRuns()
        }

        "openclaw.chat" -> {
          systemAgentChat(paramsJson)
        }

        else -> {
          error("Screenshot fixture does not implement gateway method $method with params $paramsJson")
        }
      }
    }
  }

  private fun branchRequestParams(
    paramsJson: String?,
    switching: Boolean = false,
  ): JsonObject {
    val params = requireNotNull(Json.parseToJsonElement(requireNotNull(paramsJson)) as? JsonObject) { "Expected screenshot branch request object" }
    val fields = if (switching) setOf("sessionKey", "agentId", "leafEntryId") else setOf("sessionKey", "agentId")
    require(params.keys == fields) { "Invalid screenshot branch request fields" }
    require(params["sessionKey"] == JsonPrimitive(mainSessionKey) && params["agentId"] == JsonPrimitive("main")) {
      "Screenshot branch request targets another session or agent"
    }
    if (switching) require((params["leafEntryId"] as? JsonPrimitive)?.isString == true) { "Expected screenshot branch leaf ID" }
    return params
  }

  private fun branchTitle(leaf: String): String = "Release plan ${(branchLeaves.indexOf(leaf) + 1).toString().padStart(2, '0')}"

  private fun branchTimestamp(leaf: String): Long = 1_783_555_320_000L + branchLeaves.indexOf(leaf) * 1_000L

  private fun branchList(activeLeaf: String): String =
    buildJsonObject {
      putJsonArray("branches") {
        branchLeaves.forEach { leaf ->
          addJsonObject {
            put("leafEntryId", JsonPrimitive(leaf))
            put("headline", JsonPrimitive(branchTitle(leaf)))
            put("messageCount", JsonPrimitive(2))
            put("updatedAt", JsonPrimitive(Instant.ofEpochMilli(branchTimestamp(leaf)).toString()))
            put("active", JsonPrimitive(leaf == activeLeaf))
          }
        }
      }
    }.toString()

  private fun branchSession(activeLeaf: String): JsonObject =
    buildJsonObject {
      session(mainSessionKey, "Branch selection proof", branchTimestamp(activeLeaf)).forEach { (key, value) -> put(key, value) }
      put("agentId", JsonPrimitive("main"))
      put("sessionId", JsonPrimitive("screenshot-branches"))
      put("messageCount", JsonPrimitive(2))
    }

  private fun branchSessionList(
    paramsJson: String?,
    activeLeaf: String,
  ): String {
    val params = Json.parseToJsonElement(requireNotNull(paramsJson)).jsonObject
    require(params["agentId"] == JsonPrimitive("main") && "sessionKey" !in params) { "Invalid screenshot sessions.list owner" }
    val matchesSearch =
      params["search"]?.jsonPrimitive?.contentOrNull?.let { "Branch selection proof".contains(it, ignoreCase = true) } ?: true
    val sessions =
      if (params["archived"] == JsonPrimitive(true) || !matchesSearch) emptyList() else listOf(branchSession(activeLeaf))
    return buildJsonObject {
      put("sessions", JsonArray(sessions))
      put("count", JsonPrimitive(sessions.size))
      put("totalCount", JsonPrimitive(sessions.size))
      put("hasMore", JsonPrimitive(false))
    }.toString()
  }

  private fun branchHistory(activeLeaf: String): String =
    buildJsonObject {
      put("sessionId", JsonPrimitive("screenshot-branches"))
      put("thinkingLevel", JsonPrimitive("low"))
      put("sessionInfo", branchSession(activeLeaf))
      putJsonArray("messages") {
        add(
          chatMessage(
            "user",
            "Which release plan should we use?",
            1_783_555_260_000,
            marker = buildJsonObject { put("id", JsonPrimitive("android-screenshot-branch-prompt")) },
          ),
        )
        add(
          chatMessage(
            "assistant",
            "${branchTitle(activeLeaf)}: review this alternative before preparing the release.",
            branchTimestamp(activeLeaf),
            marker = buildJsonObject { put("id", JsonPrimitive(activeLeaf)) },
          ),
        )
      }
    }.toString()

  private fun taskRecords(): List<JsonObject> =
    (1..16).map { index ->
      buildJsonObject {
        put("id", JsonPrimitive("screenshot-ledger-$index"))
        put("taskId", JsonPrimitive("screenshot-runtime-$index"))
        put("agentId", JsonPrimitive(if (index == 16) "other-agent" else "main"))
        put("title", JsonPrimitive("Release task ${index.toString().padStart(2, '0')}"))
        put("status", JsonPrimitive(if (index <= 8) "running" else "completed"))
        put("runtime", JsonPrimitive("subagent"))
        put("createdAt", JsonPrimitive(1_783_555_200_000L + index))
        put("updatedAt", JsonPrimitive(1_783_555_260_000L + index))
        put("progressSummary", JsonPrimitive("Reviewing the synthetic release checklist, item $index."))
      }
    }

  private fun backgroundTasks(paramsJson: String?): String {
    val params = Json.parseToJsonElement(checkNotNull(paramsJson)).jsonObject
    val agentId = params["agentId"]?.jsonPrimitive?.contentOrNull
    val statuses = (params["status"] as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet()
    val limit =
      params["limit"]
        ?.jsonPrimitive
        ?.content
        ?.toIntOrNull()
        ?.coerceAtLeast(0) ?: 100
    val tasks =
      taskRecords()
        .filter {
          (agentId == null || it["agentId"]?.jsonPrimitive?.content == agentId) &&
            (statuses == null || it["status"]?.jsonPrimitive?.content in statuses)
        }.take(limit)
    return buildJsonObject { put("tasks", JsonArray(tasks)) }.toString()
  }

  private fun backgroundTask(paramsJson: String?): String {
    val id =
      Json
        .parseToJsonElement(checkNotNull(paramsJson))
        .jsonObject["taskId"]
        ?.jsonPrimitive
        ?.content
    val task =
      taskRecords().firstOrNull { it["id"]?.jsonPrimitive?.content == id }
        ?: error("Screenshot fixture has no task with canonical ledger ID $id")
    val detail =
      buildJsonObject {
        task.forEach { (key, value) -> put(key, value) }
        put(
          "prompt",
          JsonPrimitive(
            (1..24).joinToString("\n\n") { "Checklist section $it: inspect the release notes and report the result without changing any files." },
          ),
        )
        put(
          "terminalSummary",
          JsonPrimitive(
            (1..24).joinToString("\n\n") { "Result section $it: the synthetic release checklist remains readable and selectable across layout changes." },
          ),
        )
      }
    return buildJsonObject { put("task", detail) }.toString()
  }

  val agents =
    listOf(
      GatewayAgentSummary(
        id = "main",
        name = "Molty",
        emoji = "M",
      ),
    )

  val models =
    listOf(
      GatewayModelSummary(
        id = "gpt-5.2",
        name = "GPT-5.2",
        provider = "openai",
        available = true,
        supportsVision = true,
        supportsAudio = true,
        supportsVideo = true,
        supportsDocuments = true,
        supportsReasoning = true,
        contextTokens = 200_000,
      ),
    )

  val providers =
    listOf(
      GatewayModelProviderSummary(
        id = "openai",
        displayName = "OpenAI",
        status = "ready",
        profileCount = 1,
      ),
    )

  val nodes =
    GatewayNodesDevicesSummary(
      nodes =
        listOf(
          GatewayNodeSummary(
            id = "android-screenshot",
            displayName = "Pixel",
            remoteIp = "100.64.0.24",
            version = BuildConfig.VERSION_NAME,
            deviceFamily = "Android",
            paired = true,
            connected = true,
            approvalState = GatewayNodeCapabilityApproval.Approved,
            capabilities = listOf("camera", "location", "notifications"),
            commands = emptyList(),
          ),
        ),
      pendingDevices = emptyList(),
      pairedDevices = emptyList(),
    )

  val channels =
    GatewayChannelsSummary(
      updatedAtMs = 1_783_555_200_000,
      channels =
        listOf(
          GatewayChannelSummary(
            id = "discord",
            label = "Discord",
            accountCount = 1,
            enabled = true,
            configured = true,
            linked = true,
            running = true,
            connected = true,
            error = null,
          ),
        ),
    )

  private fun systemAgentChat(paramsJson: String?): String {
    val message =
      paramsJson
        ?.let { Json.parseToJsonElement(it).jsonObject["message"] }
        ?.jsonPrimitive
        ?.contentOrNull
    return buildJsonObject {
      put("sessionId", JsonPrimitive("android-screenshot-openclaw"))
      put(
        "reply",
        JsonPrimitive(
          if (message == null) {
            "I can check Gateway status, repair configuration, change models, or connect channels."
          } else {
            "I’ll keep this conversation separate from ordinary agent chat."
          },
        ),
      )
      put("action", JsonPrimitive("none"))
      if (message == null) {
        putJsonObject("question") {
          put("id", JsonPrimitive("help"))
          put("header", JsonPrimitive("OpenClaw"))
          put("question", JsonPrimitive("What should we look at first?"))
          putJsonArray("options") {
            addJsonObject {
              put("label", JsonPrimitive("Check status"))
              put("description", JsonPrimitive("Review the Gateway and active services."))
              put("recommended", JsonPrimitive(true))
              put("reply", JsonPrimitive("Check Gateway status"))
            }
            addJsonObject {
              put("label", JsonPrimitive("Review setup"))
              put("description", JsonPrimitive("Inspect models, channels, and configuration."))
              put("reply", JsonPrimitive("Review setup"))
            }
          }
        }
      }
    }.toString()
  }

  private fun cronList(): String =
    buildJsonObject {
      putJsonArray("jobs") {
        add(cronJob())
      }
    }.toString()

  private fun cronJob() =
    buildJsonObject {
      put("id", JsonPrimitive(cronJobId))
      put("name", JsonPrimitive(cronJobName))
      put("enabled", JsonPrimitive(true))
      put("createdAtMs", JsonPrimitive(1_783_468_800_000))
      put("updatedAtMs", JsonPrimitive(1_783_555_200_000))
      put("configRevision", JsonPrimitive("sha256:screenshot-fixture"))
      putJsonObject("schedule") {
        put("kind", JsonPrimitive("every"))
        put("everyMs", JsonPrimitive(86_400_000))
        put("anchorMs", JsonPrimitive(1_783_468_800_000))
      }
      put("sessionTarget", JsonPrimitive("isolated"))
      put("wakeMode", JsonPrimitive("now"))
      putJsonObject("payload") {
        put("kind", JsonPrimitive("agentTurn"))
        put("message", JsonPrimitive("Summarize Android release readiness."))
        put("model", JsonPrimitive("openai/gpt-5.2"))
      }
      putJsonObject("state") {
        put("nextRunAtMs", JsonPrimitive(1_783_641_600_000))
        put("lastRunAtMs", JsonPrimitive(1_783_555_200_000))
        put("lastStatus", JsonPrimitive("ok"))
        put("lastDurationMs", JsonPrimitive(1_842))
        put("consecutiveErrors", JsonPrimitive(0))
        put("consecutiveSkipped", JsonPrimitive(0))
        put("lastDeliveryStatus", JsonPrimitive("delivered"))
      }
    }

  private fun cronRuns(): String =
    buildJsonObject {
      putJsonArray("entries") {
        addJsonObject {
          put("ts", JsonPrimitive(1_783_555_200_000))
          put("jobId", JsonPrimitive(cronJobId))
          put("runId", JsonPrimitive("android-release-digest-run-2"))
          put("action", JsonPrimitive("finished"))
          put("status", JsonPrimitive("ok"))
          put("summary", JsonPrimitive("Release checklist ready"))
          put("durationMs", JsonPrimitive(1_842))
          put("deliveryStatus", JsonPrimitive("delivered"))
          put("model", JsonPrimitive("openai/gpt-5.2"))
        }
        addJsonObject {
          put("ts", JsonPrimitive(1_783_468_800_000))
          put("jobId", JsonPrimitive(cronJobId))
          put("runId", JsonPrimitive("android-release-digest-run-1"))
          put("action", JsonPrimitive("finished"))
          put("status", JsonPrimitive("error"))
          put("error", JsonPrimitive("Play publish blocked"))
          put("durationMs", JsonPrimitive(927))
          put("deliveryStatus", JsonPrimitive("not-requested"))
          put("model", JsonPrimitive("openai/gpt-5.2"))
        }
      }
    }.toString()

  private fun sourceHistory(): String =
    buildJsonObject {
      put("sessionId", JsonPrimitive("screenshot-sources"))
      put("sessionInfo", session(mainSessionKey, "Trail research", 1_783_555_320_000))
      putJsonArray("messages") {
        add(chatMessage("user", "Find a quiet coastal walk and explain what to expect.", 1_783_555_260_000))
        addJsonObject {
          put("role", JsonPrimitive("toolResult"))
          put("runId", JsonPrimitive("source-preview-run"))
          put("toolName", JsonPrimitive("web_search"))
          put("toolCallId", JsonPrimitive("source-search"))
          put("timestamp", JsonPrimitive(1_783_555_275_000))
          putJsonObject("details") {
            put("kind", JsonPrimitive("results"))
            putJsonObject("externalContent") {
              put("source", JsonPrimitive("web_search"))
              put("untrusted", JsonPrimitive(true))
              put("wrapped", JsonPrimitive(true))
            }
            putJsonArray("results") {
              listOf(
                Triple("https://parks.example.org/coast", "Coastal trail guide", "A sheltered coastal path with open sea views, gentle grades, and several quiet picnic spots."),
                Triple("https://trails.example.org/shore", "Shoreline walking notes", "The eastern trailhead is usually quieter. Morning walkers often see herons along the inlet."),
                Triple("https://gateway.example/chat/main/source-preview", "Research session", "Related research session."),
                Triple("https://github.com/openclaw/openclaw/issues/123", "Tracking issue", "Related tracking issue."),
              ).forEach { (url, title, snippet) ->
                fun wrapped(value: String) = "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"0123456789abcdef\">>>\nSource: Web Search\n---\n$value\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"0123456789abcdef\">>>"
                addJsonObject {
                  put("url", JsonPrimitive(url))
                  put("title", JsonPrimitive(wrapped(title)))
                  put("snippet", JsonPrimitive(wrapped(snippet)))
                }
              }
            }
          }
          put("content", JsonPrimitive("Found two coastal walking guides."))
        }
        addJsonObject {
          put("role", JsonPrimitive("assistant"))
          put("runId", JsonPrimitive("source-preview-run"))
          put("phase", JsonPrimitive("final_answer"))
          put("timestamp", JsonPrimitive(1_783_555_290_000))
          put("content", JsonPrimitive("Try the **coastal trail** for a gentle walk with sea views and sheltered picnic spots. Start at the eastern trailhead in the morning for a quieter route.\n\nBring water and a light layer; the exposed sections can be breezy. See the [park guide](https://parks.example.org/coast) and [walking notes](https://trails.example.org/shore).\n\nRelated: [research session](https://gateway.example/chat/main/source-preview) · [tracking issue](https://github.com/openclaw/openclaw/issues/123)."))
        }
      }
    }.toString()

  private fun workHistory(): String =
    buildJsonObject {
      put("sessionId", JsonPrimitive("screenshot-work"))
      put("thinkingLevel", JsonPrimitive("low"))
      put("sessionInfo", session(mainSessionKey, "Checklist review", 1_783_555_320_000))
      putJsonArray("messages") {
        add(chatMessage("user", "Check the release checklist and summarize what is ready.", 1_783_555_260_000))
        add(workMessage("review", "I’ll read the checklist and check the results.", 1_783_555_265_000, "commentary"))
        add(workTool("read", "read", "docs/release-checklist.md", "Checklist read: build, tests, and documentation.", 1_783_555_270_000))
        if (scene == AndroidScreenshotScene.WorkBoundaries) {
          addJsonObject {
            put("role", JsonPrimitive("assistant"))
            put("timestamp", JsonPrimitive(1_783_555_280_000))
            put("phase", JsonPrimitive("commentary"))
            putJsonArray("content") {
              addJsonObject {
                put("type", JsonPrimitive("text"))
                put("text", JsonPrimitive("The checklist attachment is available here."))
              }
              addJsonObject {
                put("type", JsonPrimitive("file"))
                put("mimeType", JsonPrimitive("text/plain"))
                put("fileName", JsonPrimitive("release-checklist.txt"))
                put("sizeBytes", JsonPrimitive(48))
                put("url", JsonPrimitive("https://example.com/release-checklist.txt"))
              }
            }
          }
          add(workTool("verify", "exec", "check localization", "Localization check failed: one translation is missing.", 1_783_555_290_000, isError = true))
          addJsonObject {
            put("role", JsonPrimitive("assistant"))
            put("id", JsonPrimitive("android-screenshot-final-audit-call"))
            put("timestamp", JsonPrimitive(1_783_555_310_000))
            putJsonArray("content") {
              addJsonObject {
                put("type", JsonPrimitive("toolCall"))
                put("id", JsonPrimitive("android-screenshot-call-final-audit"))
                put("name", JsonPrimitive("exec"))
                put("arguments", buildJsonObject { put("command", JsonPrimitive("check final release audit")) })
              }
            }
          }
          add(workMessage("answer", "The build and tests are ready. One translation still needs attention.", 1_783_555_320_000, "final_answer"))
          addJsonObject {
            put("role", JsonPrimitive("toolResult"))
            put("id", JsonPrimitive("android-screenshot-final-audit-result"))
            put("timestamp", JsonPrimitive(1_783_555_330_000))
            put("toolCallId", JsonPrimitive("android-screenshot-call-final-audit"))
            put("toolName", JsonPrimitive("exec"))
            put("content", JsonPrimitive("Final audit failed: signature check needs attention."))
            put("isError", JsonPrimitive(true))
          }
        } else {
          add(workMessage("verify", "The checklist is complete. I’ll verify the test results.", 1_783_555_280_000, "commentary"))
          add(workTool("tests", "exec", "check release results", "Build passed. Tests passed. Documentation checked.", 1_783_555_300_000))
          if (scene == AndroidScreenshotScene.CompletedWork) {
            add(workMessage("answer", "The release checklist is ready: the build, tests, and documentation checks passed.", 1_783_555_320_000, "final_answer"))
          }
        }
      }
      if (scene == AndroidScreenshotScene.ActiveWork) {
        putJsonObject("inFlightRun") {
          put("runId", JsonPrimitive("android-screenshot-work-active"))
          put("text", JsonPrimitive("I’m checking the final release details."))
        }
      }
    }.toString()

  private fun workMessage(
    id: String,
    text: String,
    timestamp: Long,
    phase: String,
  ) = buildJsonObject {
    chatMessage("assistant", text, timestamp).forEach { (key, value) -> put(key, value) }
    put("id", JsonPrimitive("android-screenshot-work-$id"))
    put("phase", JsonPrimitive(phase))
  }

  private fun workTool(
    id: String,
    name: String,
    detail: String,
    result: String,
    timestamp: Long,
    isError: Boolean = false,
  ) = buildJsonObject {
    put("role", JsonPrimitive("assistant"))
    put("id", JsonPrimitive("android-screenshot-tool-$id"))
    put("timestamp", JsonPrimitive(timestamp))
    putJsonArray("content") {
      addJsonObject {
        put("type", JsonPrimitive("toolCall"))
        put("id", JsonPrimitive("android-screenshot-call-$id"))
        put("name", JsonPrimitive(name))
        put("arguments", buildJsonObject { put(if (name == "read") "path" else "command", JsonPrimitive(detail)) })
      }
      addJsonObject {
        put("type", JsonPrimitive("toolResult"))
        put("toolCallId", JsonPrimitive("android-screenshot-call-$id"))
        put("name", JsonPrimitive(name))
        put("content", JsonPrimitive(result))
        put("isError", JsonPrimitive(isError))
      }
    }
  }

  private fun chatHistory(): String =
    buildJsonObject {
      put("sessionId", JsonPrimitive("screenshot-session"))
      put("thinkingLevel", JsonPrimitive("low"))
      putJsonArray("messages") {
        repeat(24) { index ->
          add(
            chatMessage(
              role = "assistant",
              content = "Earlier discussion ${index + 1}: keep the release note concise and describe the user-visible change.",
              timestamp = 1_783_550_000_000 + index * 10_000L,
            ),
          )
        }
        add(chatMessage("user", "What is blocking the Android release?", 1_783_555_020_000))
        add(
          chatMessage(
            "assistant",
            "Two review threads are still open on the release branch, and the localization sync needs one more pass. " +
              "Once those land, the changelog draft is ready for review and the tag can go out.",
            1_783_555_080_000,
          ),
        )
        add(
          chatMessage(
            role = "user",
            content = "[System] Continue the interrupted turn.",
            timestamp = 1_783_555_100_000,
            provenanceSourceTool = "main_session_restart_recovery",
          ),
        )
        add(
          chatMessage(
            role = "user",
            content = "[System] Gateway restarted during the Android release update.",
            timestamp = 1_783_555_120_000,
            provenanceSourceTool = "restart-sentinel",
          ),
        )
        add(chatMessage("user", "Summarize the open review feedback for me.", 1_783_555_140_000))
        add(
          chatMessage(
            "assistant",
            "The release check is ready:\n\n```kotlin\nval ready = lint && tests\n```\n\n" +
              "Review https://openclaw.ai before tagging.",
            1_783_555_200_000,
          ),
        )
        add(
          chatMessage(
            role = "system",
            content = "Compaction",
            timestamp = 1_783_555_220_000,
            marker =
              buildJsonObject {
                put("kind", JsonPrimitive("compaction"))
                put("id", JsonPrimitive("android-screenshot-compaction"))
                put("tokensBefore", JsonPrimitive(900_000))
                put("tokensAfter", JsonPrimitive(24_700))
              },
          ),
        )
        add(
          chatMessage(
            role = "system",
            content = "Reset",
            timestamp = 1_783_555_240_000,
            marker =
              buildJsonObject {
                put("kind", JsonPrimitive("reset"))
                put("id", JsonPrimitive("android-screenshot-reset"))
              },
          ),
        )
        add(chatMessage("user", "Draft a short status update for the team.", 1_783_555_260_000))
        add(
          chatMessage(
            role = "assistant",
            content =
              "The Android release is close. Two review follow-ups and one localization pass remain; once those land, " +
                "the changelog can be reviewed and the tag can go out.",
            timestamp = 1_783_555_320_000,
            provider = "openai",
            model = "gpt-5.2",
            usage =
              buildJsonObject {
                put("input", JsonPrimitive(2_100))
                put("output", JsonPrimitive(160))
                put("cacheRead", JsonPrimitive(76_500))
              },
            cost =
              buildJsonObject {
                put("input", JsonPrimitive(0.003))
                put("output", JsonPrimitive(0.004))
                put("cacheRead", JsonPrimitive(0.0015))
                put("total", JsonPrimitive(0.0085))
              },
          ),
        )
      }
      putJsonObject("sessionInfo") {
        put("key", JsonPrimitive(mainSessionKey))
        put("displayName", JsonPrimitive("New chat"))
        put("updatedAt", JsonPrimitive(1_783_555_320_000))
        put("unread", JsonPrimitive(false))
        put("modelProvider", JsonPrimitive("openai"))
        put("model", JsonPrimitive("gpt-5.2"))
        put("inputTokens", JsonPrimitive(18_420))
        put("outputTokens", JsonPrimitive(840))
        put("totalTokens", JsonPrimitive(109_800))
        put("totalTokensFresh", JsonPrimitive(true))
        put("contextTokens", JsonPrimitive(272_000))
        put("estimatedCostUsd", JsonPrimitive(0.022956))
      }
      putJsonObject("inFlightRun") {
        put("runId", JsonPrimitive("android-screenshot-active-run"))
        put("text", JsonPrimitive(""))
      }
    }.toString()

  private fun chatMessage(
    role: String,
    content: String,
    timestamp: Long,
    provenanceSourceTool: String? = null,
    marker: JsonObject? = null,
    provider: String? = null,
    model: String? = null,
    usage: JsonObject? = null,
    cost: JsonObject? = null,
  ) = buildJsonObject {
    put("role", JsonPrimitive(role))
    put("content", JsonPrimitive(content))
    put("timestamp", JsonPrimitive(timestamp))
    provenanceSourceTool?.let { sourceTool ->
      putJsonObject("provenance") {
        put("kind", JsonPrimitive("internal_system"))
        put("sourceTool", JsonPrimitive(sourceTool))
      }
    }
    marker?.let { put("__openclaw", it) }
    provider?.let { put("provider", JsonPrimitive(it)) }
    model?.let { put("model", JsonPrimitive(it)) }
    usage?.let { put("usage", it) }
    cost?.let { put("cost", it) }
  }

  private fun sessionList(paramsJson: String?): String {
    val spawnedBy =
      paramsJson
        ?.let {
          runCatching {
            Json
              .parseToJsonElement(it)
              .jsonObject["spawnedBy"]
              ?.jsonPrimitive
              ?.contentOrNull
          }.getOrNull()
        }
    if (scene == AndroidScreenshotScene.Swarm && spawnedBy != null) {
      val children = swarmChildren(spawnedBy)
      return buildJsonObject {
        put("sessions", buildJsonArray { children.forEach(::add) })
        put("count", JsonPrimitive(children.size))
        put("totalCount", JsonPrimitive(children.size))
        put("hasMore", JsonPrimitive(false))
      }.toString()
    }
    return buildJsonObject {
      putJsonArray("sessions") {
        add(session("discord:release-planning", primarySessionTitle, 1_783_555_200_000))
        add(session("main", "Product notes", 1_783_468_800_000))
        add(session("discord:android", "Android QA", 1_783_382_400_000))
      }
      put("totalCount", JsonPrimitive(3))
    }.toString()
  }

  private fun swarmChildren(parentKey: String) =
    listOf(
      swarmChild("research-polling", "National polling", "done", parentKey),
      swarmChild("research-work", "Work and labor", "running", parentKey),
      swarmChild("research-health", "Health", "running", parentKey),
      swarmChild("research-trust", "Governance and trust", null, parentKey, queued = true),
      swarmChild("research-media", "Media signals", "failed", parentKey),
    )

  private fun swarmChild(
    key: String,
    label: String,
    status: String?,
    parentKey: String,
    queued: Boolean = false,
  ) = buildJsonObject {
    session("agent:main:subagent:$key", label, 1_783_555_320_000).forEach { (field, value) -> put(field, value) }
    put("parentSessionKey", JsonPrimitive(parentKey))
    put("spawnedBy", JsonPrimitive(parentKey))
    put("swarmGroupId", JsonPrimitive("swarm:$parentKey:research"))
    put("swarmPhase", JsonPrimitive("Research"))
    put("swarmPhaseRank", JsonPrimitive(0))
    put("swarmLog", JsonPrimitive("Comparing labor, education, health, trust, and media signals."))
    status?.let { put("status", JsonPrimitive(it)) }
    if (queued) put("subagentRunState", JsonPrimitive("active"))
    if (status == "running") put("hasActiveRun", JsonPrimitive(true))
  }

  private fun session(
    key: String,
    displayName: String,
    updatedAt: Long,
  ) = buildJsonObject {
    put("key", JsonPrimitive(key))
    put("displayName", JsonPrimitive(displayName))
    put("updatedAt", JsonPrimitive(updatedAt))
    put("lastActivityAt", JsonPrimitive(updatedAt))
    put("unread", JsonPrimitive(false))
    put("archived", JsonPrimitive(false))
    put("category", JsonNull)
    put("modelProvider", JsonPrimitive("openai"))
    put("model", JsonPrimitive("gpt-5.2"))
    put("inputTokens", JsonPrimitive(18_420))
    put("outputTokens", JsonPrimitive(840))
    put("totalTokens", JsonPrimitive(109_800))
    put("totalTokensFresh", JsonPrimitive(true))
    put("contextTokens", JsonPrimitive(272_000))
    put("estimatedCostUsd", JsonPrimitive(0.022956))
  }

  private fun chatMetadata(): String =
    buildJsonObject {
      put("swarmEnabled", JsonPrimitive(scene == AndroidScreenshotScene.Swarm))
      putJsonArray("commands") {
        listOf(
          Triple("help", "Show available commands.", false),
          Triple("commands", "List all slash commands.", false),
          Triple("tools", "List available runtime tools.", true),
          Triple("skill", "Run a skill by name.", true),
          Triple("learn", "Draft a reusable skill from recent work or named sources.", true),
          Triple("loop", "Loop a prompt: /loop [interval] <prompt> | /loop status | /loop stop [name]", true),
        ).forEach { (name, description, acceptsArgs) ->
          addJsonObject {
            put("name", JsonPrimitive(name))
            put("description", JsonPrimitive(description))
            put("acceptsArgs", JsonPrimitive(acceptsArgs))
          }
        }
      }
    }.toString()

  private fun modelCatalog(): String =
    buildJsonObject {
      putJsonArray("models") {
        addJsonObject {
          put("id", JsonPrimitive("gpt-5.2"))
          put("name", JsonPrimitive("GPT-5.2"))
          put("provider", JsonPrimitive("openai"))
          put("available", JsonPrimitive(true))
          put("reasoning", JsonPrimitive(true))
          put("supportsFastMode", JsonPrimitive(true))
          put("thinkingDefault", JsonPrimitive("medium"))
          putJsonArray("thinkingLevels") {
            for (level in listOf("off", "low", "medium", "high")) {
              addJsonObject {
                put("id", JsonPrimitive(level))
                put("label", JsonPrimitive(level.replaceFirstChar { it.uppercase() }))
              }
            }
          }
          put("contextWindow", JsonPrimitive(200_000))
          putJsonArray("input") {
            add(JsonPrimitive("text"))
            add(JsonPrimitive("image"))
            add(JsonPrimitive("audio"))
            add(JsonPrimitive("document"))
          }
        }
      }
    }.toString()
}
