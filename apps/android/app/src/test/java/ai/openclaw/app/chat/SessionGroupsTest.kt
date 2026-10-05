package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionGroupsTest {
  @Test
  fun parsesCatalogOrderAndSkipsBlankNames() {
    val groups =
      parseSessionGroupsPayload(
        """{"ok":true,"groups":[{"name":" dankar ","position":1},{"name":"CODEX","position":0},{"name":" ","position":2},{"position":3}],"sectionOrder":["category:CODEX"]}""",
      )

    assertEquals(listOf("CODEX" to 0, "dankar" to 1), groups?.map { it.name to it.position })
    assertEquals(
      listOf("category:CODEX"),
      parseSessionGroupCatalog(
        """{"ok":true,"groups":[{"name":"CODEX","position":0}],"sectionOrder":["category:CODEX","nope",""]}""",
      )?.sectionOrder,
    )
  }

  @Test
  fun missingGroupsArrayIsNotAnEmptyCatalog() {
    assertNull(parseSessionGroupsPayload("""{"ok":true}"""))
    assertNull(parseSessionGroupsPayload("not-json"))
    assertEquals(emptyList<GatewaySessionGroup>(), parseSessionGroupsPayload("""{"groups":[]}"""))
  }

  @Test
  fun offUltraShapeDoesNotMatterHereAndLegacyIsNotAnotherGatewaysCatalog() {
    val restricted =
      decideSessionGroupMigration(
        listedNames = emptyList(),
        legacyNames = listOf("Folder"),
        alreadyMigrated = false,
        canPut = true,
      )
    assertEquals(true, restricted.putLegacy)
    assertEquals(true, restricted.consumeLegacy)

    val otherGateway =
      decideSessionGroupMigration(
        listedNames = emptyList(),
        legacyNames = emptyList(),
        alreadyMigrated = false,
        canPut = true,
      )
    assertEquals(false, otherGateway.putLegacy)
    assertEquals(false, otherGateway.consumeLegacy)

    val nonempty =
      decideSessionGroupMigration(
        listedNames = listOf("Work"),
        legacyNames = listOf("Folder"),
        alreadyMigrated = false,
        canPut = true,
      )
    assertEquals(false, nonempty.putLegacy)
    assertEquals(true, nonempty.consumeLegacy)
    assertEquals(listOf("Work", "Extra"), unionSessionGroupNames(listOf("Work"), listOf("Extra", "Work")))
  }

  @Test
  fun moveDownStepsOntoTheNextVisibleSection() {
    val order =
      listOf(
        "category:Alpha",
        "category:Beta",
        "ungrouped",
        "groups",
        "work",
        "catalog:codex",
      )
    val visible =
      listOf(
        "category:Alpha",
        "category:Beta",
        "ungrouped",
        "groups",
        "catalog:codex",
      )

    assertEquals(
      listOf("category:Alpha", "ungrouped", "category:Beta", "groups", "work", "catalog:codex"),
      moveSidebarSectionByDirection(order, visible, "category:Beta", direction = 1),
    )
    assertEquals(
      listOf("category:Beta", "category:Alpha", "ungrouped", "groups", "work", "catalog:codex"),
      moveSidebarSectionByDirection(order, visible, "category:Beta", direction = -1),
    )
    assertEquals(null, moveSidebarSectionByDirection(order, visible, "category:Alpha", direction = -1))
  }

  @Test
  fun movePastGroupsKeepsHiddenWorkBesideTheCatalog() {
    val order = listOf("ungrouped", "groups", "work", "catalog:codex")
    val visible = listOf("ungrouped", "groups", "catalog:codex")

    assertEquals(
      listOf("ungrouped", "work", "catalog:codex", "groups"),
      moveSidebarSectionByDirection(order, visible, "groups", direction = 1),
    )
    assertEquals(
      listOf("Alpha", "Beta"),
      sidebarCategoryNames(listOf("category:Alpha", "ungrouped", "category:Beta", "catalog:codex")),
    )
  }
}
