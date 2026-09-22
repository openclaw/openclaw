plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.android.test) apply false
  alias(libs.plugins.ktlint) apply false
  alias(libs.plugins.kotlin.compose) apply false
  alias(libs.plugins.kotlin.serialization) apply false
}

subprojects {
  plugins.withId("com.android.application") {
    tasks.withType<Test>().configureEach {
      // Robolectric 4.17 uses SharedSecrets to initialize SDK 37 file descriptors.
      jvmArgs("--add-opens=java.base/jdk.internal.access=ALL-UNNAMED")
    }
  }
}
