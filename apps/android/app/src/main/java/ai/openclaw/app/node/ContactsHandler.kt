package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.hasPermission
import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.provider.ContactsContract
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

private const val DEFAULT_CONTACTS_LIMIT = 25

@Serializable
internal data class ContactRecord(
  val identifier: String,
  val displayName: String,
  val givenName: String,
  val familyName: String,
  val organizationName: String,
  val phoneNumbers: List<String>,
  val emails: List<String>,
)

internal data class ContactsSearchRequest(
  val query: String?,
  val limit: Int,
)

internal data class ContactsAddRequest(
  val givenName: String?,
  val familyName: String?,
  val organizationName: String?,
  val displayName: String?,
  val phoneNumbers: List<String>,
  val emails: List<String>,
)

internal interface ContactsDataSource {
  fun hasReadPermission(context: Context): Boolean

  fun hasWritePermission(context: Context): Boolean

  fun search(
    context: Context,
    request: ContactsSearchRequest,
  ): List<ContactRecord>

  fun add(
    context: Context,
    request: ContactsAddRequest,
  ): ContactRecord
}

private object SystemContactsDataSource : ContactsDataSource {
  override fun hasReadPermission(context: Context): Boolean = context.hasPermission(Manifest.permission.READ_CONTACTS)

  override fun hasWritePermission(context: Context): Boolean = context.hasPermission(Manifest.permission.WRITE_CONTACTS)

  override fun search(
    context: Context,
    request: ContactsSearchRequest,
  ): List<ContactRecord> {
    val resolver = context.contentResolver
    val projection =
      arrayOf(
        ContactsContract.Contacts._ID,
        ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
      )
    // Escape wildcard characters so user text remains a substring search, not a LIKE pattern.
    val selectionArgs = request.query?.takeUnless(String::isBlank)?.let { arrayOf("%${escapeSqlLikeLiteral(it)}%") }
    val selection = selectionArgs?.let { "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} LIKE ? ESCAPE '\\'" }
    val sortOrder = "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} COLLATE NOCASE ASC LIMIT ${request.limit}"
    resolver
      .query(
        ContactsContract.Contacts.CONTENT_URI,
        projection,
        selection,
        selectionArgs,
        sortOrder,
      ).use { cursor ->
        if (cursor == null) return emptyList()
        val idIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
        val displayNameIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
        val out = mutableListOf<ContactRecord>()
        while (cursor.moveToNext() && out.size < request.limit) {
          val contactId = cursor.getLong(idIndex)
          val displayName = cursor.getString(displayNameIndex).orEmpty()
          out += loadContactRecord(resolver, contactId, fallbackDisplayName = displayName)
        }
        return out
      }
  }

  override fun add(
    context: Context,
    request: ContactsAddRequest,
  ): ContactRecord {
    val resolver = context.contentResolver
    val operations = ArrayList<ContentProviderOperation>()
    operations +=
      ContentProviderOperation
        .newInsert(ContactsContract.RawContacts.CONTENT_URI)
        .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
        .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
        .build()
    // Subsequent Data rows use back-reference 0 to attach to the RawContact inserted above.
    if (!request.givenName.isNullOrEmpty() || !request.familyName.isNullOrEmpty() || !request.displayName.isNullOrEmpty()) {
      operations +=
        newContactData(ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME, request.givenName)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME, request.familyName)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, request.displayName)
          .build()
    }
    if (!request.organizationName.isNullOrEmpty()) {
      operations +=
        newContactData(ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.Organization.COMPANY, request.organizationName)
          .build()
    }
    request.phoneNumbers.forEach { number ->
      operations +=
        newContactData(ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
          .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
          .build()
    }
    request.emails.forEach { email ->
      operations +=
        newContactData(ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
          .withValue(ContactsContract.CommonDataKinds.Email.TYPE, ContactsContract.CommonDataKinds.Email.TYPE_HOME)
          .build()
    }

    val results = resolver.applyBatch(ContactsContract.AUTHORITY, operations)
    val rawContactId =
      results
        .firstOrNull()
        ?.uri
        ?.lastPathSegment
        ?.toLongOrNull()
        ?: throw IllegalStateException("contact insert failed")
    val contactId =
      // Android returns the RawContact id; resolve the aggregate Contact id used by search APIs.
      resolveContactIdForRawContact(resolver, rawContactId)
        ?: throw IllegalStateException("contact insert failed")
    return loadContactRecord(
      resolver = resolver,
      contactId = contactId,
      fallbackDisplayName = request.displayName.orEmpty(),
    )
  }

  private fun newContactData(mimeType: String): ContentProviderOperation.Builder =
    ContentProviderOperation
      .newInsert(ContactsContract.Data.CONTENT_URI)
      .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
      .withValue(ContactsContract.Data.MIMETYPE, mimeType)

  private fun resolveContactIdForRawContact(
    resolver: ContentResolver,
    rawContactId: Long,
  ): Long? {
    val projection = arrayOf(ContactsContract.RawContacts.CONTACT_ID)
    resolver
      .query(
        ContactsContract.RawContacts.CONTENT_URI,
        projection,
        "${ContactsContract.RawContacts._ID}=?",
        arrayOf(rawContactId.toString()),
        null,
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        val index = cursor.getColumnIndexOrThrow(ContactsContract.RawContacts.CONTACT_ID)
        return cursor.getLong(index)
      }
  }

  private fun loadContactRecord(
    resolver: ContentResolver,
    contactId: Long,
    fallbackDisplayName: String,
  ): ContactRecord {
    val nameRow =
      loadContactData(
        resolver,
        contactId,
        ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
        arrayOf(
          ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME,
          ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME,
          ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME,
        ),
      ) { cursor ->
        NameRow(
          givenName = cursor.getString(0)?.trim()?.ifEmpty { null },
          familyName = cursor.getString(1)?.trim()?.ifEmpty { null },
          displayName = cursor.getString(2)?.trim()?.ifEmpty { null },
        )
      } ?: NameRow(givenName = null, familyName = null, displayName = null)
    val organization =
      loadContactData(
        resolver,
        contactId,
        ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
        arrayOf(ContactsContract.CommonDataKinds.Organization.COMPANY),
      ) { it.getString(0)?.trim()?.ifEmpty { null } }
    val phones =
      queryContactValues(
        resolver = resolver,
        contentUri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
        valueColumn = ContactsContract.CommonDataKinds.Phone.NUMBER,
        contactIdColumn = ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
        contactId = contactId,
      )
    val emails =
      queryContactValues(
        resolver = resolver,
        contentUri = ContactsContract.CommonDataKinds.Email.CONTENT_URI,
        valueColumn = ContactsContract.CommonDataKinds.Email.ADDRESS,
        contactIdColumn = ContactsContract.CommonDataKinds.Email.CONTACT_ID,
        contactId = contactId,
      )
    val displayName =
      (nameRow.displayName ?: fallbackDisplayName).ifEmpty {
        listOfNotNull(nameRow.givenName, nameRow.familyName).joinToString(" ").ifEmpty {
          organization ?: phones.firstOrNull() ?: emails.firstOrNull() ?: "(unnamed)"
        }
      }
    return ContactRecord(
      identifier = contactId.toString(),
      displayName = displayName,
      givenName = nameRow.givenName.orEmpty(),
      familyName = nameRow.familyName.orEmpty(),
      organizationName = organization.orEmpty(),
      phoneNumbers = phones,
      emails = emails,
    )
  }

  private data class NameRow(
    val givenName: String?,
    val familyName: String?,
    val displayName: String?,
  )

  private inline fun <T> loadContactData(
    resolver: ContentResolver,
    contactId: Long,
    mimeType: String,
    projection: Array<String>,
    read: (Cursor) -> T,
  ): T? =
    resolver
      .query(
        ContactsContract.Data.CONTENT_URI,
        projection,
        "${ContactsContract.Data.CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
        arrayOf(contactId.toString(), mimeType),
        null,
      ).use { cursor ->
        if (cursor != null && cursor.moveToFirst()) read(cursor) else null
      }

  private fun queryContactValues(
    resolver: ContentResolver,
    contentUri: android.net.Uri,
    valueColumn: String,
    contactIdColumn: String,
    contactId: Long,
  ): List<String> {
    val projection = arrayOf(valueColumn)
    resolver
      .query(
        contentUri,
        projection,
        "$contactIdColumn=?",
        arrayOf(contactId.toString()),
        null,
      ).use { cursor ->
        if (cursor == null) return emptyList()
        val out = LinkedHashSet<String>()
        while (cursor.moveToNext()) {
          val value = cursor.getString(0)?.trim().orEmpty()
          if (value.isNotEmpty()) out += value
        }
        return out.toList()
      }
  }
}

class ContactsHandler internal constructor(
  private val appContext: Context,
  private val dataSource: ContactsDataSource = SystemContactsDataSource,
) {
  fun handleContactsSearch(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasReadPermission(appContext)) {
      return nodeInvokeError("CONTACTS_PERMISSION_REQUIRED", "grant Contacts permission")
    }
    val request =
      parseSearchRequest(paramsJson)
        ?: return nodeInvokeError("INVALID_REQUEST", "expected JSON object")
    return try {
      val contacts = dataSource.search(appContext, request)
      GatewaySession.InvokeResult.ok(Json.encodeToString(mapOf("contacts" to contacts)))
    } catch (err: Throwable) {
      nodeInvokeError("CONTACTS_UNAVAILABLE", err.message ?: "contacts query failed")
    }
  }

  fun handleContactsAdd(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasWritePermission(appContext)) {
      return nodeInvokeError("CONTACTS_PERMISSION_REQUIRED", "grant Contacts permission")
    }
    val request =
      parseAddRequest(paramsJson)
        ?: return nodeInvokeError("INVALID_REQUEST", "expected JSON object")
    val hasName =
      !(request.givenName.isNullOrEmpty() && request.familyName.isNullOrEmpty() && request.displayName.isNullOrEmpty())
    val hasOrg = !request.organizationName.isNullOrEmpty()
    val hasDetails = request.phoneNumbers.isNotEmpty() || request.emails.isNotEmpty()
    if (!hasName && !hasOrg && !hasDetails) {
      return nodeInvokeError("CONTACTS_INVALID", "include a name, organization, phone, or email")
    }
    return try {
      val contact = dataSource.add(appContext, request)
      GatewaySession.InvokeResult.ok(Json.encodeToString(mapOf("contact" to contact)))
    } catch (err: Throwable) {
      nodeInvokeError("CONTACTS_UNAVAILABLE", err.message ?: "contact add failed")
    }
  }

  private fun parseSearchRequest(paramsJson: String?): ContactsSearchRequest? {
    if (paramsJson.isNullOrBlank()) {
      return ContactsSearchRequest(query = null, limit = DEFAULT_CONTACTS_LIMIT)
    }
    val params = parseJsonParamsObject(paramsJson) ?: return null
    val query = (params["query"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null }
    // Keep gateway-driven searches bounded even if the model asks for a large contact dump.
    val limit = ((params["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: DEFAULT_CONTACTS_LIMIT).coerceIn(1, 200)
    return ContactsSearchRequest(query = query, limit = limit)
  }

  private fun parseAddRequest(paramsJson: String?): ContactsAddRequest? {
    val params = parseJsonParamsObject(paramsJson) ?: return null
    return ContactsAddRequest(
      givenName = parseJsonString(params, "givenName")?.trim()?.ifEmpty { null },
      familyName = parseJsonString(params, "familyName")?.trim()?.ifEmpty { null },
      organizationName = parseJsonString(params, "organizationName")?.trim()?.ifEmpty { null },
      displayName = parseJsonString(params, "displayName")?.trim()?.ifEmpty { null },
      phoneNumbers = stringArray(params["phoneNumbers"] as? JsonArray),
      // Store emails case-normalized so repeated model calls do not create casing-only duplicates.
      emails = stringArray(params["emails"] as? JsonArray).map { it.lowercase() },
    )
  }

  private fun stringArray(array: JsonArray?): List<String> {
    if (array == null) return emptyList()
    return array.mapNotNull { element ->
      element.asStringOrNull()?.trim()?.ifEmpty { null }
    }
  }
}
