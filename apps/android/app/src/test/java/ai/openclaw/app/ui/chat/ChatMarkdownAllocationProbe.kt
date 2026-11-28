package ai.openclaw.app.ui.chat

import com.sun.management.ThreadMXBean
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.SourceSpan
import java.lang.management.ManagementFactory
import java.util.Collections
import java.util.IdentityHashMap

/** Opt-in JVM allocation workload; this is not collected as a unit test. */
internal object ChatMarkdownAllocationProbe {
  @JvmStatic
  fun main(args: Array<String>) {
    require(args.isEmpty())
    val bean = ManagementFactory.getThreadMXBean() as ThreadMXBean
    check(bean.isThreadAllocatedMemorySupported)
    check(bean.isCurrentThreadCpuTimeSupported)
    bean.isThreadAllocatedMemoryEnabled = true
    bean.isThreadCpuTimeEnabled = true
    val code = "x\n".repeat(32_000) + "ALLOCATION_TAIL\n"
    val url = "https://example.test/tail"
    val source = "Introduction\n\n```text\n$code```\n\n[tail]($url)"
    println("phase,sample,allocatedBytes,elapsedNanos,cpuNanos,sourceSpans")

    fun sample(
      phase: String,
      index: Int,
    ) {
      val cpuBefore = bean.currentThreadCpuTime
      val allocatedBefore = bean.currentThreadAllocatedBytes
      val started = System.nanoTime()
      val document = parseChatMarkdown(source)
      val elapsed = System.nanoTime() - started
      val allocated = bean.currentThreadAllocatedBytes - allocatedBefore
      val cpu = bean.currentThreadCpuTime - cpuBefore

      val fence = document.firstChild.next as FencedCodeBlock
      check(fence.literal == code && fence.info == "text" && fence.closingFenceLength == 3)
      check((fence.next.firstChild as Link).destination == url)
      val spans = Collections.newSetFromMap(IdentityHashMap<SourceSpan, Boolean>())
      val pending = ArrayDeque<Node>()
      pending.add(document)
      while (pending.isNotEmpty()) {
        val node = pending.removeFirst()
        spans.addAll(node.sourceSpans)
        pending.addAll(markdownSiblings(node.firstChild))
      }
      println("$phase,$index,$allocated,$elapsed,$cpu,${spans.size}")
    }

    sample("cold", 0)
    repeat(2) { parseChatMarkdown(source) }
    repeat(5) { sample("warm", it + 1) }
  }
}
