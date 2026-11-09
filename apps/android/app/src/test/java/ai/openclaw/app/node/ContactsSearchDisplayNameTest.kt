package ai.openclaw.app.node

import android.Manifest
import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.ContactsContract
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@Config(sdk = [34])
class ContactsSearchDisplayNameTest : NodeHandlerRobolectricTest() {
  @Test
  fun searchPreservesAggregateDisplayNameInsteadOfFirstRawContactName() {
    val provider = AggregateNameContactsProvider("Robert Smith", listOf("Bob", "Robert Smith"))
    val contact = searchContact(provider, "Robert")

    assertEquals("Robert Smith", contact.getValue("displayName").jsonPrimitive.content)
    assertEquals("42", contact.getValue("identifier").jsonPrimitive.content)
    assertEquals("%Robert%", provider.searchArgument)
    val numbers = contact.getValue("phoneNumbers").jsonArray
    assertEquals("+15555550123", numbers.single().jsonPrimitive.content)
  }

  @Test
  fun searchKeepsSingleContactNameAndFallsBackWhenAggregateNameIsMissing() {
    for (aggregateName in listOf("Bob", "")) {
      val provider = AggregateNameContactsProvider(aggregateName, listOf("Bob"))
      val contact = searchContact(provider, null)

      assertEquals("Bob", contact.getValue("displayName").jsonPrimitive.content)
      assertEquals("42", contact.getValue("identifier").jsonPrimitive.content)
    }
  }

  private fun searchContact(
    provider: AggregateNameContactsProvider,
    query: String?,
  ): JsonObject {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.READ_CONTACTS)
    val info = ProviderInfo().apply { authority = ContactsContract.AUTHORITY }
    provider.attachInfo(app, info)
    ShadowContentResolver.registerProviderInternal(ContactsContract.AUTHORITY, provider)
    val params = query?.let { """{"query":"$it"}""" }

    val result = ContactsHandler(app).handleContactsSearch(params)

    assertTrue("contacts.search failed: " + result.error?.message, result.ok)
    val payload = Json.parseToJsonElement(requireNotNull(result.payloadJson)).jsonObject
    val contacts = payload.getValue("contacts").jsonArray
    return contacts.single().jsonObject
  }
}

private class AggregateNameContactsProvider(
  private val aggregateName: String,
  private val rawNames: List<String>,
) : ContentProvider() {
  var searchArgument: String? = null
    private set

  override fun onCreate(): Boolean = true

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val cursor = MatrixCursor(requireNotNull(projection))
    when (uri) {
      ContactsContract.Contacts.CONTENT_URI -> {
        searchArgument = selectionArgs?.singleOrNull()
        cursor.addRow(arrayOf<Any?>(42L, aggregateName))
      }

      ContactsContract.Data.CONTENT_URI -> {
        if (selectionArgs?.lastOrNull() == ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE) {
          rawNames.forEach { name -> cursor.addRow(arrayOf(name, "", name)) }
        }
      }

      ContactsContract.CommonDataKinds.Phone.CONTENT_URI -> cursor.addRow(arrayOf("+15555550123"))
      ContactsContract.CommonDataKinds.Email.CONTENT_URI -> Unit
      else -> error("unexpected contacts URI: $uri")
    }
    return cursor
  }

  override fun insert(
    uri: Uri,
    values: ContentValues?,
  ): Uri? = error("read-only fixture")

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = error("read-only fixture")

  override fun delete(
    uri: Uri,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = error("read-only fixture")

  override fun getType(uri: Uri): String? = null
}
