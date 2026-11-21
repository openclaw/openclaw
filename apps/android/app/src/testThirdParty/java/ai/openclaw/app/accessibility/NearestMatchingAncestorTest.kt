package ai.openclaw.app.accessibility

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NearestMatchingAncestorTest {
  private data class Node(val name: String, val clickable: Boolean, val parent: Node? = null)

  private val row = Node("row", clickable = true)
  private val group = Node("group", clickable = false, parent = row)
  private val label = Node("label", clickable = false, parent = group)

  @Test
  fun returnsNearestClickableAncestor() {
    assertEquals(row, nearestMatchingAncestor(label, { it.parent }, { it.clickable }))
  }

  @Test
  fun returnsNullWithoutClickableAncestor() {
    val lone = Node("lone", clickable = false, parent = Node("root", clickable = false))
    assertNull(nearestMatchingAncestor(lone, { it.parent }, { it.clickable }))
  }

  @Test
  fun stopsAtMaxDepth() {
    assertNull(nearestMatchingAncestor(label, { it.parent }, { it.clickable }, maxDepth = 1))
  }
}
