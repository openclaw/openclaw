package ai.openclaw.app.buddy

object NemoAgentProfile {
  const val AGENT_ID = "nemo"
  const val AGENT_NAME = "Nemo"
  private const val ANDROID_SESSION_PREFIX = "android-buddy"
  private const val SETUP_SESSION_BASE = "nemo-setup"

  fun isNemoAgentId(agentId: String?): Boolean =
    agentId?.trim()?.equals(AGENT_ID, ignoreCase = true) == true

  fun hasNemoProfile(agentIds: Iterable<String>): Boolean =
    agentIds.any(::isNemoAgentId)

  fun androidSessionKey(deviceId: String): String {
    val suffix = deviceId.trim().take(12).ifEmpty { "device" }
    return "agent:$AGENT_ID:$ANDROID_SESSION_PREFIX-$suffix"
  }

  fun setupSessionKey(defaultAgentId: String?): String {
    val trimmed = defaultAgentId?.trim().orEmpty()
    return if (trimmed.isEmpty() || isNemoAgentId(trimmed)) {
      SETUP_SESSION_BASE
    } else {
      "agent:$trimmed:$SETUP_SESSION_BASE"
    }
  }

  fun setupPrompt(): String =
    """
    请帮我为 OpenClaw 初始化一个名为 Nemo 的桌宠 Agent profile。

    目标：
    1. 在 Gateway 配置中新增或修复 agents.list[] 条目：
       - id: nemo
       - name: Nemo
       - identity.name: Nemo
       - identity.emoji: 选择一个适合电子桌宠的简洁符号
       - workspace: ~/.openclaw/workspace-nemo
    2. 为 Nemo 创建独立 workspace：
       - ~/.openclaw/workspace-nemo/SOUL.md
       - ~/.openclaw/workspace-nemo/MEMORY.md
       - 如果当前 OpenClaw agent workspace 规范需要 AGENTS.md 或 TOOLS.md，也请创建最小必要文件
    3. Nemo 的人设：
       - Nemo 是 OpenClaw 的桌面电子宠物，不是控制台
       - 面向普通用户，回复简短、自然、亲切
       - 能用普通语言说明自己正在听、看、思考、执行工具
       - 需要 camera、voice、node 能力时，先自然说明目的
       - 不输出密钥、token、隐私配置或内部调试细节
    4. 保持主 agent 和默认 agent 设置不变，不把 Nemo 设为默认 agent。
    5. 完成后请告诉我是否需要重启 Gateway 或执行额外命令。

    请先检查当前配置结构，再做最小必要修改。不要输出任何 token、密钥或隐私内容。
    """.trimIndent()
}

enum class NemoProfileStatus {
  Unknown,
  Missing,
  Initializing,
  Ready,
  NeedsRestart,
  Failed,
}
