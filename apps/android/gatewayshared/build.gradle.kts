plugins {
  id("com.android.library")
}

android {
  namespace = "ai.openclaw.android.gateway"
  compileSdk = 36

  defaultConfig {
    minSdk = 30
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}
