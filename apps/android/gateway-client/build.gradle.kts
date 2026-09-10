plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.ktlint)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "ai.openclaw.gateway.client"
  compileSdk = 37

  defaultConfig {
    minSdk = 31
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  lint {
    warningsAsErrors = true
  }

  testOptions {
    unitTests.isIncludeAndroidResources = true
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

ktlint {
  version.set(libs.versions.ktlint.cli)
  android.set(true)
  ignoreFailures.set(false)
  filter {
    exclude("**/build/**")
  }
}

dependencies {
  api(libs.kotlinx.coroutines.android)
  api(libs.kotlinx.serialization.json)
  api(libs.okhttp)
  implementation(libs.bcprov)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.mockwebserver)
  testImplementation(libs.robolectric)
}
