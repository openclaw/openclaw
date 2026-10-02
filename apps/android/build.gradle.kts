plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.android.test) apply false
  alias(libs.plugins.ktlint) apply false
  alias(libs.plugins.kotlin.compose) apply false
  alias(libs.plugins.kotlin.serialization) apply false
}

subprojects {
  tasks.withType<Test>().configureEach {
    // Robolectric retains SDK/resource sandboxes across the full suite; the Gradle daemon
    // heap does not apply to these forked workers, including shared library tests.
    maxHeapSize = "1g"
    if (project.path == ":app" && System.getenv("CI_RUNNER_BACKEND") == "blacksmith") {
      // Separate JVMs keep Robolectric sandboxes isolated while other classes await sockets.
      val processors = Runtime.getRuntime().availableProcessors()
      maxParallelForks = minOf(4, processors)
      // Give each JVM its CPU share instead of sizing every GC and worker pool for the whole runner.
      jvmArgs("-XX:ActiveProcessorCount=${maxOf(1, processors / maxParallelForks)}")
    }
    // Robolectric 4.17 uses SharedSecrets to initialize SDK 37 file descriptors.
    jvmArgs("--add-opens=java.base/jdk.internal.access=ALL-UNNAMED")
  }
}
