plugins {
  alias(libs.plugins.android.library)
}

val nativeDirectory = rootProject.layout.projectDirectory.dir("../../crates/openclaw-iroh-ffi")

android {
  namespace = "ai.openclaw.iroh"
  compileSdk = 37

  defaultConfig {
    minSdk = 31
  }

  sourceSets.getByName("main") {
    kotlin.directories.add(nativeDirectory.dir("generated").asFile.path)
    kotlin.directories.add(nativeDirectory.dir("android").asFile.path)
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    // UniFFI 0.31.2 generates warnings under Kotlin 2.4.21. Do not edit its generated
    // bindings; isolate them and their Android initializer from the app's strict gate.
    allWarningsAsErrors.set(false)
  }
}

dependencies {
  implementation(libs.kotlinx.coroutines.android)
  implementation("${libs.jna.get()}@aar")
}
