package ai.openclaw.android.notification

class NotificationFilter(
  private val ownPackageName: String,
  private val allowedPackages: () -> Set<String>,
  private val blockedPackages: () -> Set<String>,
) {
  companion object {
    private val SENSITIVE_PACKAGE_PATTERNS =
      listOf(
        Regex(".*\\.banking\\..*"),
        Regex(".*\\.bank\\..*"),
        Regex(".*\\.authenticator.*"),
        Regex(".*\\.otp.*"),
        Regex(".*\\.health\\..*"),
        Regex(".*\\.medical\\..*"),
        Regex(".*\\.2fa.*"),
        Regex(".*\\.totp.*"),
      )

    /** Maximum text length extracted from a notification. */
    const val MAX_TEXT_LENGTH = 500

    fun isSensitivePackage(packageName: String): Boolean {
      return SENSITIVE_PACKAGE_PATTERNS.any { it.matches(packageName) }
    }
  }

  fun shouldCapture(packageName: String, category: String?): Boolean {
    // Always block own package.
    if (packageName == ownPackageName) return false

    // Check explicit blocklist.
    val blocked = blockedPackages()
    if (blocked.contains(packageName)) return false

    // Check sensitive package patterns.
    if (isSensitivePackage(packageName)) return false

    // If allowlist is non-empty, only capture listed apps.
    val allowed = allowedPackages()
    if (allowed.isNotEmpty() && !allowed.contains(packageName)) return false

    return true
  }
}
