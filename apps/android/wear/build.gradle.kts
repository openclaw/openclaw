import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.ktlint)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

val openClawAndroidVersionFile = rootProject.file("Config/Version.properties")
val openClawAndroidVersionProperties =
  Properties().apply {
    if (!openClawAndroidVersionFile.isFile) {
      error("Missing Android version properties. Run `pnpm android:version:sync`.")
    }
    openClawAndroidVersionFile.inputStream().use(::load)
  }

fun requireOpenClawAndroidVersionProperty(name: String): String =
  (providers.gradleProperty(name).orNull ?: openClawAndroidVersionProperties.getProperty(name))?.trim()?.takeIf { it.isNotEmpty() }
    ?: error("Missing $name in Config/Version.properties. Run `pnpm android:version:sync`.")

fun parseOpenClawAndroidVersionCode(
  name: String,
  value: String,
): Int {
  val code = value.trim().toIntOrNull()
  check(code != null && code in 1..2_100_000_000) {
    "$name must be a positive integer no greater than 2100000000."
  }
  return code
}

val openClawAndroidPhoneVersionCode =
  parseOpenClawAndroidVersionCode("OPENCLAW_ANDROID_VERSION_CODE", requireOpenClawAndroidVersionProperty("OPENCLAW_ANDROID_VERSION_CODE"))
val explicitOpenClawAndroidWearVersionCode = providers.gradleProperty("OPENCLAW_ANDROID_WEAR_VERSION_CODE").orNull
val openClawAndroidWearVersionCode =
  if (explicitOpenClawAndroidWearVersionCode != null) {
    parseOpenClawAndroidVersionCode("OPENCLAW_ANDROID_WEAR_VERSION_CODE", explicitOpenClawAndroidWearVersionCode)
  } else {
    check(openClawAndroidPhoneVersionCode % 100 in 1..49) {
      "Android pinned build number must be 01 through 49; Wear reserves 51 through 99."
    }
    parseOpenClawAndroidVersionCode("OPENCLAW_ANDROID_WEAR_VERSION_CODE", (openClawAndroidPhoneVersionCode + 50).toString())
  }
check(openClawAndroidWearVersionCode > openClawAndroidPhoneVersionCode) {
  "Wear versionCode must be greater than the phone versionCode."
}

// Data Layer delivery requires the phone and watch packages to share one certificate.
evaluationDependsOn(":app")
val phoneReleaseSigning =
  project(":app")
    .extensions
    .getByType<com.android.build.api.dsl.ApplicationExtension>()
    .signingConfigs
    .findByName("release")

android {
  namespace = "ai.openclaw.wear"
  compileSdk = 37

  defaultConfig {
    // Data Layer traffic is scoped to matching package names and signatures.
    applicationId = "ai.openclaw.app"
    minSdk = 31
    targetSdk = 36
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    versionCode = openClawAndroidWearVersionCode
    versionName = requireOpenClawAndroidVersionProperty("OPENCLAW_ANDROID_VERSION_NAME")
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      versionNameSuffix = "-debug"
    }
    release {
      if (phoneReleaseSigning != null) {
        signingConfig = phoneReleaseSigning
      }
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  buildFeatures {
    compose = true
  }

  testOptions {
    unitTests.isIncludeAndroidResources = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }

  lint {
    lintConfig = rootProject.file("app/lint.xml")
    warningsAsErrors = true
  }
}

androidComponents {
  onVariants(selector().withBuildType("release")) { variant ->
    variant.lifecycleTasks.registerPreBuild(":app:validateOpenClawReleaseSigning")
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
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)

  implementation(project(":wear-shared"))
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.core.splashscreen)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.viewmodel.ktx)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.wear.compose.foundation)
  implementation(libs.androidx.wear.compose.material3)
  implementation(libs.androidx.wear.input)
  implementation(libs.androidx.wear.tiles)
  implementation(libs.androidx.wear.protolayout)
  implementation(libs.androidx.wear.protolayout.material)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.play.services.wearable)

  debugImplementation(libs.androidx.compose.ui.tooling)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.androidx.compose.ui.test.junit4)

  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.uiautomator)
}
