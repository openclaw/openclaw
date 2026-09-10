package ai.openclaw.app.gateway

/** App-owned secure storage used by gateway identity, role tokens, and registry state. */
interface GatewayCredentialStore {
  fun getString(key: String): String?

  fun putString(
    key: String,
    value: String,
  )

  /** Reports the durable commit result; identity and registry owners decide when to publish. */
  fun putStringSynchronously(
    key: String,
    value: String,
  ): Boolean

  /** Commits one credential update and restores previous in-memory values on failure. */
  fun commitSecureStrings(values: Map<String, String>): Boolean

  fun remove(key: String)
}
