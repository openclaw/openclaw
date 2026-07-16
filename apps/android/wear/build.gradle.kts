import com.android.build.api.variant.impl.VariantOutputImpl
import java.util.Properties

val openClawAndroidVersionFile = rootProject.file("Config/Version.properties")
val openClawAndroidVersionProperties =
  Properties().apply {
    if (!openClawAndroidVersionFile.isFile) {
      error("Missing Android version properties. Run `pnpm android:version:sync`.")
    }
    openClawAndroidVersionFile.inputStream().use(::load)
  }

fun requireOpenClawAndroidVersionProperty(name: String): String =
  openClawAndroidVersionProperties.getProperty(name)?.trim()?.takeIf { it.isNotEmpty() }
    ?: error("Missing $name in Config/Version.properties. Run `pnpm android:version:sync`.")

val androidStoreFile = providers.gradleProperty("OPENCLAW_ANDROID_STORE_FILE").orNull?.takeIf { it.isNotBlank() }
val androidStorePassword = providers.gradleProperty("OPENCLAW_ANDROID_STORE_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val androidKeyAlias = providers.gradleProperty("OPENCLAW_ANDROID_KEY_ALIAS").orNull?.takeIf { it.isNotBlank() }
val androidKeyPassword = providers.gradleProperty("OPENCLAW_ANDROID_KEY_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val resolvedAndroidStoreFile =
  androidStoreFile?.let { storeFilePath ->
    if (storeFilePath.startsWith("~/")) {
      "${System.getProperty("user.home")}/${storeFilePath.removePrefix("~/")}"
    } else {
      storeFilePath
    }
  }
val hasAndroidReleaseSigning =
  listOf(resolvedAndroidStoreFile, androidStorePassword, androidKeyAlias, androidKeyPassword).all { it != null }

val openClawAndroidWearVersionCode =
  requireOpenClawAndroidVersionProperty("OPENCLAW_ANDROID_WEAR_VERSION_CODE").toIntOrNull()
    ?: error("OPENCLAW_ANDROID_WEAR_VERSION_CODE must be an integer in Config/Version.properties.")

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.ktlint)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "ai.openclaw.wear"
  compileSdk = 37

  // Phone and Wear must use the same signing identity for Wear Data Layer delivery.
  signingConfigs {
    if (hasAndroidReleaseSigning) {
      create("release") {
        storeFile = project.file(checkNotNull(resolvedAndroidStoreFile))
        storePassword = checkNotNull(androidStorePassword)
        keyAlias = checkNotNull(androidKeyAlias)
        keyPassword = checkNotNull(androidKeyPassword)
      }
    }
  }

  defaultConfig {
    // Wear Data Layer traffic is scoped to matching package names and signatures.
    applicationId = "ai.openclaw.app"
    minSdk = 31
    targetSdk = 36
    versionCode = openClawAndroidWearVersionCode
    versionName = requireOpenClawAndroidVersionProperty("OPENCLAW_ANDROID_VERSION_NAME")
  }

  buildTypes {
    release {
      if (hasAndroidReleaseSigning) {
        signingConfig = signingConfigs.getByName("release")
      }
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  buildFeatures {
    compose = true
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
  onVariants { variant ->
    variant.outputs
      .filterIsInstance<VariantOutputImpl>()
      .forEach { output ->
        output.outputFileName = "OpenClaw-WearOS-${variant.buildType}.apk"
      }
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

ktlint {
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
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.play.services.wearable)
  implementation(libs.wear.compose.foundation)
  implementation(libs.wear.compose.material3)
  implementation(libs.wear.input)

  debugImplementation(libs.androidx.compose.ui.tooling)

  testImplementation(libs.junit)
}
